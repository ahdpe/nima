// Time-lapse recorder: a compact keyframe of the whole world every two minutes of
// world time, kept for seven days in one file per world day.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { WORLD, GRID } from './environment.mjs';
import { hueOf } from './frames.mjs';
import { roleOf } from './world.mjs';

export const EVERY = 120, PLANTS_EVERY = 600, ALGAE = 32, KEEP_DAYS = 7;
const ROLE = { producer: 0, grazer: 1, predator: 2, scavenger: 3, none: 4 };
const u8 = v => Math.min(255, Math.max(0, Math.round(v)));

// Keyframe layout (little endian):
// u32 t-seconds | u16 animals | u16 plants (0 if not included) | u16 counts[5] (roles)
// animals: x u8, y u8, hue u8, role/size u8 (role 3 bits, size 5 bits)
// plants:  x u8, y u8, size u8
// algae:   ALGAE×ALGAE u8
export function keyframe(world) {
  const animals = world.creatures.filter(c => c.p.acts && c.p.thrust > 0);
  const withPlants = Math.round(world.t) % PLANTS_EVERY < EVERY;
  const plants = withPlants ? world.creatures.filter(c => !c.p.acts) : [];
  const h = world.history.at(-1)?.roles || {};
  const buf = Buffer.alloc(18 + animals.length * 4 + plants.length * 3 + ALGAE * ALGAE);
  buf.writeUInt32LE(Math.round(world.t), 0); buf.writeUInt16LE(Math.min(65535, animals.length), 4); buf.writeUInt16LE(Math.min(65535, plants.length), 6);
  ['producer', 'grazer', 'predator', 'scavenger', 'none'].forEach((k, i) => buf.writeUInt16LE(Math.min(65535, h[k] || 0), 8 + i * 2));
  let o = 18;
  for (const c of animals) {
    buf[o] = u8(c.x / WORLD * 256 - .5); buf[o + 1] = u8(c.y / WORLD * 256 - .5); buf[o + 2] = u8(hueOf(c.g) * 255);
    buf[o + 3] = (ROLE[roleOf(c.intake, c.p)] << 5) | Math.min(31, Math.round(c.p.radius * 6));
    o += 4;
  }
  for (const c of plants) { buf[o] = u8(c.x / WORLD * 256 - .5); buf[o + 1] = u8(c.y / WORLD * 256 - .5); buf[o + 2] = u8(c.scale * 255); o += 3; }
  const step = GRID / ALGAE;
  for (let y = 0; y < ALGAE; y++) for (let x = 0; x < ALGAE; x++) {
    let sum = 0; for (let j = 0; j < step; j++) for (let i = 0; i < step; i++) sum += world.A[(y * step + j) * GRID + x * step + i];
    buf[o++] = u8(sum / (step * step) * 255);
  }
  return buf;
}

// Frames are appended with a u32 length prefix to the file of their world day.
export class Recorder {
  constructor(directory) { this.dir = path.join(directory, 'timelapse'); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }
  file(day) { return path.join(this.dir, `day-${String(day).padStart(6, '0')}.bin`); }
  record(world) {
    const frame = keyframe(world), day = Math.floor(world.t / 86400), len = Buffer.alloc(4);
    len.writeUInt32LE(frame.length, 0);
    fs.appendFileSync(this.file(day), Buffer.concat([len, frame]), { mode: 0o600 });
    for (const name of fs.readdirSync(this.dir).filter(n => /^day-\d+\.bin$/.test(n)).sort().slice(0, -KEEP_DAYS)) fs.unlinkSync(path.join(this.dir, name));
  }
  // The last `hours` of keyframes, gzip-compressed, prefixed with world size.
  pack(hours = 24, now) {
    const from = now - hours * 3600, out = [], files = fs.readdirSync(this.dir).filter(n => /^day-\d+\.bin$/.test(n)).sort();
    for (const name of files) {
      const day = Number(name.slice(4, 10)); if ((day + 1) * 86400 < from) continue;
      const bytes = fs.readFileSync(path.join(this.dir, name));
      for (let o = 0; o + 4 <= bytes.length;) {
        const len = bytes.readUInt32LE(o); if (o + 4 + len > bytes.length) break; // a torn last frame is skipped
        const t = bytes.readUInt32LE(o + 4);
        if (t >= from) out.push(bytes.subarray(o, o + 4 + len));
        o += 4 + len;
      }
    }
    const head = Buffer.alloc(8); head.write('TLP1', 0); head.writeUInt16LE(WORLD, 4); head.writeUInt16LE(ALGAE, 6);
    return gzipSync(Buffer.concat([head, ...out]), { level: 6 });
  }
}
