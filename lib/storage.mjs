// Durable world state: checksummed checkpoints with a previous copy, daily
// archives, and append-only chronicle files (events, fossils, hourly history).
import fs from 'node:fs';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const MAGIC = 'EPOCHS1\n';

export class Storage {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lastSavedAt = 0; this.wasFallback = false;
  }
  file(name) { return path.join(this.directory, name); }

  // One engine owns a data directory. A stale lock from a dead process is replaced.
  lock() {
    const file = this.file('engine.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); this.locked = file; return; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(fs.readFileSync(file, 'utf8'));
        let alive = false; try { process.kill(pid, 0); alive = pid !== process.pid; } catch {}
        if (alive) throw Error(`Data directory is owned by running process ${pid}`);
        fs.unlinkSync(file);
      }
    }
    throw Error('Could not lock data directory');
  }
  unlock() { if (this.locked) { try { fs.unlinkSync(this.locked); } catch {} this.locked = null; } }

  load() {
    let found = false;
    for (const name of ['world.ckpt', 'world.previous.ckpt']) {
      const file = this.file(name);
      if (!fs.existsSync(file)) continue;
      found = true;
      try {
        const bytes = fs.readFileSync(file);
        if (bytes.subarray(0, MAGIC.length).toString() !== MAGIC) throw Error('Bad header');
        const digest = bytes.subarray(MAGIC.length, MAGIC.length + 64).toString();
        const body = bytes.subarray(MAGIC.length + 65);
        if (createHash('sha256').update(body).digest('hex') !== digest) throw Error('Checksum mismatch');
        const state = deserialize(gunzipSync(body, { maxOutputLength: 512 * 1024 * 1024 }));
        this.wasFallback = name.includes('previous');
        return { ...state, recoveredFromPrevious: this.wasFallback };
      } catch (error) { console.error(`Checkpoint ${name}: ${error.message}`); }
    }
    if (found) throw Error('Both checkpoints are unreadable. Restore a backup; the world will not be replaced.');
    if (fs.existsSync(this.file('events.jsonl'))) throw Error('Checkpoints are missing but the chronicle exists. Restore a backup.');
    return null;
  }

  save(world, meta) {
    const savedAt = Date.now();
    const body = gzipSync(serialize({ world: world.export(), savedAt, ...meta }), { level: 1 });
    const digest = createHash('sha256').update(body).digest('hex');
    const bytes = Buffer.concat([Buffer.from(`${MAGIC}${digest}\n`), body]);
    const temporary = this.file(`.world-${process.pid}.tmp`);
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const current = this.file('world.ckpt');
    if (fs.existsSync(current) && !this.wasFallback) fs.renameSync(current, this.file('world.previous.ckpt'));
    fs.renameSync(temporary, current);
    this.wasFallback = false;
    try { const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch {}
    this.lastSavedAt = savedAt;
    return bytes.length;
  }

  // Daily copy of the checkpoint; the last 30 are kept.
  archiveDay(day) {
    const directory = this.file('days'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `day-${String(day).padStart(6, '0')}.ckpt`);
    if (!fs.existsSync(target)) fs.copyFileSync(this.file('world.ckpt'), target);
    const days = fs.readdirSync(directory).filter(n => /^day-\d+\.ckpt$/.test(n)).sort();
    for (const old of days.slice(0, -30)) fs.unlinkSync(path.join(directory, old));
  }

  append(name, records) {
    if (!records.length) return;
    const fd = fs.openSync(this.file(name), 'a', 0o600);
    try { fs.writeSync(fd, records.map(r => JSON.stringify(r)).join('\n') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  // Read an append-only file, dropping a torn final line left by a crash.
  read(name, limit = Infinity) {
    const file = this.file(name);
    if (!fs.existsSync(file)) return [];
    let text = fs.readFileSync(file, 'utf8');
    if (text.length && !text.endsWith('\n')) { text = text.slice(0, text.lastIndexOf('\n') + 1); fs.truncateSync(file, Buffer.byteLength(text)); }
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(Math.max(0, lines.length - limit)).map(l => JSON.parse(l));
  }
}
