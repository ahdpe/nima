// Binary frames for viewers. Every viewer receives the same bytes; the browser
// interpolates between frames and computes light, day and season itself.
import { WORLD, GRID } from './environment.mjs';

export const KIND = { ACTORS: 1, PLANTS: 7, FIELDS: 3, BODIES: 8 }; // older layouts: plants 2 (no axis), bodies 4 (no plan), 5 (no segments, forms), 6 (no pigment, leaf)
export const PLANT_BYTES = 11;
export const VERSION = 2;
const HEADER = 24;
const q16 = v => Math.min(65535, Math.max(0, Math.round(v / WORLD * 65536))) & 0xffff;
const u8 = v => Math.min(255, Math.max(0, Math.round(v * 255)));

function header(buf, kind, world, count) {
  buf.writeUInt8(kind, 0); buf.writeUInt8(VERSION, 1); buf.writeUInt16LE(WORLD, 2);
  buf.writeUInt32LE(world.tick, 4); buf.writeDoubleLE(world.t, 8); buf.writeUInt32LE(count, 16);
  buf.writeFloatLE(world.dust ?? 1, 20);
}

// Bodies that act: 12 bytes each. The last byte packs light-organ output (5 bits)
// with hurt and infected flags.
export function actorsFrame(world) {
  const list = world.creatures.filter(c => c.p.acts);
  const buf = Buffer.alloc(HEADER + list.length * 12);
  header(buf, KIND.ACTORS, world, list.length);
  let o = HEADER;
  for (const c of list) {
    buf.writeUInt32LE(c.id, o); buf.writeUInt16LE(q16(c.x), o + 4); buf.writeUInt16LE(q16(c.y), o + 6);
    buf[o + 8] = Math.round(((c.a / (2 * Math.PI)) % 1 + 1) % 1 * 256) & 255;
    buf[o + 9] = u8(c.scale); buf[o + 10] = u8(c.e / c.p.cap);
    buf[o + 11] = (Math.min(31, Math.round(c.glow * 31)) << 3) | (c.hurt > .3 ? 1 : 0) | (c.inf ? 2 : 0);
    o += 12;
  }
  return buf;
}

// Sessile bodies: 11 bytes each; the last is the fixed axis a filament or a bush grows along.
export function plantsFrame(world) {
  const list = world.creatures.filter(c => !c.p.acts);
  const buf = Buffer.alloc(HEADER + list.length * PLANT_BYTES);
  header(buf, KIND.PLANTS, world, list.length);
  let o = HEADER;
  for (const c of list) {
    buf.writeUInt32LE(c.id, o); buf.writeUInt16LE(q16(c.x), o + 4); buf.writeUInt16LE(q16(c.y), o + 6);
    buf[o + 8] = u8(c.scale); buf[o + 9] = u8(c.e / c.p.cap); buf[o + 10] = Math.round(((c.a / (2 * Math.PI)) % 1 + 1) % 1 * 256) & 255; o += PLANT_BYTES;
  }
  return buf;
}

// Algae, depth, detritus and toxin at half the field resolution, one byte each.
export function fieldsFrame(world) {
  const f = GRID > 256 && GRID % 3 === 0 ? 3 : 2, n = GRID / f, buf = Buffer.alloc(HEADER + n * n * 4); // at most ~128² for viewers
  header(buf, KIND.FIELDS, world, n);
  let o = HEADER;
  const layers = [[world.A, 1], [world.shallow, 1], [world.D, 2], [world.T, 1]];
  for (const [field, scale] of layers) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let v = 0; for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) v += field[(y * f + j) * GRID + x * f + i];
    buf[o++] = u8(Math.min(1, v / (f * f) / scale));
  }
  return buf;
}

// Body plans: what each creature is made of. Sent once per creature.
export function hueOf(g) { return ((g.markers[0] * .7 + g.markers[1] * .3) % 1 + 1) % 1; }
export function bodiesFrame(world, creatures) {
  let size = HEADER;
  for (const c of creatures) size += 18 + c.g.modules.length * 3;
  const buf = Buffer.alloc(size);
  header(buf, KIND.BODIES, world, creatures.length);
  let o = HEADER;
  for (const c of creatures) {
    buf.writeUInt32LE(c.id, o); buf.writeUInt32LE(c.sp, o + 4);
    buf[o + 8] = u8(hueOf(c.g)); buf[o + 9] = u8(c.g.diet); buf[o + 10] = c.p.acts ? 1 : 0; buf[o + 11] = c.g.modules.length;
    buf[o + 12] = c.g.sym; buf[o + 13] = u8(c.g.elong / 2.5); // body plan: symmetry and length
    buf[o + 14] = c.p.seg; buf[o + 15] = c.p.form;             // segments of an animal, growth form of a plant
    buf[o + 16] = u8(c.g.pig); buf[o + 17] = u8(c.g.leaf);     // pigment of the chloroplasts, shape of the leaves
    o += 18;
    for (const m of c.g.modules) { buf[o] = m.t; buf[o + 1] = u8(m.s / 1.5); buf[o + 2] = Math.round(((m.a / (2 * Math.PI)) % 1 + 1) % 1 * 256) & 255; o += 3; }
  }
  return buf;
}

// Summary for the interface, sent as JSON every few seconds.
export function summary(world) {
  const h = world.history.at(-1) || {};
  const species = [];
  for (const s of world.species.values()) if (s.count > 0) species.push({ established: s.established,
    id: s.id, parent: s.parent, count: s.count, peak: s.peak, role: s.role, born: s.born, epoch: s.epoch, lazarus: s.lazarus || null, immigrant: s.immigrant || null,
    hue: hueOf(s.sample), modules: s.sample.modules.map(m => m.t), diet: +s.sample.diet.toFixed(2), sym: s.sample.sym, elong: +s.sample.elong.toFixed(2), seg: s.sample.seg, form: s.sample.form, pig: +s.sample.pig.toFixed(2), leaf: +s.sample.leaf.toFixed(2)
  });
  species.sort((a, b) => b.count - a.count);
  // Twelve hours of role counts, one point per ten minutes, for the population chart.
  const trend = [];
  for (let i = world.history.length - 1; i >= 0 && trend.length < 72; i -= 10) {
    const r = world.history[i]; trend.unshift([Math.round(r.t), r.roles.producer, r.roles.grazer, r.roles.predator, r.roles.scavenger]);
  }
  return { type: 'summary', trend, createdAt: undefined, t: world.t, tick: world.tick, epoch: world.epoch, world: WORLD, climatePhases: world.climatePhases, dust: world.dust,
    climate: world.climate, roles: h.roles, species: species.slice(0, 200), living: world.liveSpecies(), infected: h.infected,
    counters: world.counters, events: world.events.slice(-20), meteor: world.meteor, firsts: world.firsts, weather: world.weather };
}
