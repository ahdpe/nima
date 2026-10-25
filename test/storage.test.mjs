import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../lib/storage.mjs';
import { World, HZ } from '../lib/world.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'epochs-'));
const small = () => { const w = new World({ seed: 3, plants: 150, grazers: 10 }); for (let i = 0; i < HZ * 30; i++) w.step(); return w; };

test('a damaged checkpoint falls back to the previous copy', () => {
  const dir = tmp(), s = new Storage(dir), w = small();
  s.save(w, { createdAt: 1 });
  for (let i = 0; i < HZ * 5; i++) w.step();
  s.save(w, { createdAt: 1 });
  const file = path.join(dir, 'world.ckpt'), bytes = fs.readFileSync(file);
  bytes[bytes.length - 10] ^= 0xff; fs.writeFileSync(file, bytes);
  const loaded = new Storage(dir).load();
  assert.equal(loaded.recoveredFromPrevious, true);
  assert.equal(World.restore(loaded.world).tick, HZ * 30);
});

test('two damaged checkpoints stop the engine instead of replacing the world', () => {
  const dir = tmp(), s = new Storage(dir), w = small();
  s.save(w, {}); s.save(w, {});
  for (const name of ['world.ckpt', 'world.previous.ckpt']) fs.writeFileSync(path.join(dir, name), 'EPOCHS1\nbroken');
  assert.throws(() => new Storage(dir).load(), /unreadable/);
});

test('missing checkpoints with an existing chronicle are refused', () => {
  const dir = tmp(), s = new Storage(dir);
  s.append('events.jsonl', [{ seq: 1 }]);
  assert.throws(() => s.load(), /chronicle exists/);
});

test('only one live process may own a data directory', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'engine.lock'), String(process.ppid));
  assert.throws(() => new Storage(dir).lock(), /owned by running process/);
  fs.writeFileSync(path.join(dir, 'engine.lock'), '999999999');
  const s = new Storage(dir); s.lock(); s.unlock();
});

test('a torn final chronicle line is dropped on read', () => {
  const dir = tmp(), s = new Storage(dir);
  s.append('events.jsonl', [{ seq: 1 }, { seq: 2 }]);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"seq":3,"t');
  assert.deepEqual(s.read('events.jsonl').map(e => e.seq), [1, 2]);
});
