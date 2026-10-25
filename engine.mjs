// Real-time owner of the canonical world. One process, one data directory.
// The world advances at HZ steps per real second whether or not anyone watches.
import { World, HZ, portrait } from './lib/world.mjs';
import { genomeOf } from './lib/demiurge.mjs';
import { Storage } from './lib/storage.mjs';
import { actorsFrame, plantsFrame, fieldsFrame, bodiesFrame, summary } from './lib/frames.mjs';
import { Recorder, EVERY } from './lib/timelapse.mjs';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const env = process.env;
const store = new Storage(env.EPOCHS_DATA_DIR || './data');
store.lock();
const SAVE_EVERY = Number(env.EPOCHS_SAVE_SECONDS || 300) * 1000;
const CATCHUP = Number(env.EPOCHS_CATCHUP_SECONDS || 3600);
const recorder = new Recorder(store.directory);
// Every computed second counts, including preparation and catch-up: keyframes are recorded throughout.
function advance(w) { w.step(); if (w.tick % (HZ * EVERY) === 0) recorder.record(w); }

let world, createdAt, written;
const loaded = store.load();
if (loaded) {
  world = World.restore(loaded.world);
  createdAt = loaded.createdAt; written = loaded.written;
  // Time the server was down is computed, up to a limit; the rest is an honest pause.
  const missed = Math.max(0, Math.floor((Date.now() - loaded.savedAt) / 1000));
  const catchUp = Math.min(missed, CATCHUP);
  for (let i = 0; i < catchUp * HZ; i++) advance(world);
  if (missed > 2) world.event('resumed', { computed: catchUp, paused: missed - catchUp, fromPrevious: !!loaded.recoveredFromPrevious });
} else {
  world = new World({ seed: Number(env.EPOCHS_SEED || 731947) });
  // A computed preparation period, recorded as such; no hand-placed organisms after genesis.
  const warmup = Number(env.EPOCHS_WARMUP_SECONDS || 1800);
  for (let i = 0; i < warmup * HZ; i++) advance(world);
  world.event('opening', { preparedSeconds: warmup });
  createdAt = Date.now();
  written = { events: 0, fossils: 0, hour: -1, day: -1 };
}

// Durable chronicle: append what is new since the last write. Replayed records
// carry the same sequence numbers and are skipped.
function chronicle() {
  store.append('events.jsonl', world.events.filter(e => e.seq > written.events));
  store.append('fossils.jsonl', world.fossils.filter(f => f.seq > written.fossils));
  written.events = world.eventSeq; written.fossils = world.fossilSeq;
  const hour = Math.floor(world.t / 3600);
  if (hour !== written.hour && world.history.length) {
    const h = world.history.at(-1);
    store.append('history.jsonl', [{ ...h, at: Date.now() }]);
    written.hour = hour;
  }
}
function save() {
  chronicle();
  const bytes = store.save(world, { createdAt, written });
  const day = Math.floor(world.t / 86400);
  if (day !== written.day) { store.archiveDay(day); written.day = day; }
  return bytes;
}
let checkpointBytes = save();

// Status for operators: one small JSON file, replaced atomically.
let stepMs = 0, steps = 0, maxStep = 0, cpuMark = process.cpuUsage(), wallMark = performance.now();
function status() {
  const now = performance.now(), cpu = process.cpuUsage(cpuMark), h = world.history.at(-1) || {};
  const s = { at: Date.now(), createdAt, t: world.t, epoch: world.epoch, creatures: world.creatures.length, roles: h.roles,
    species: h.species, established: h.established, cpuPercent: +((cpu.user + cpu.system) / 1000 / (now - wallMark) * 100).toFixed(2),
    stepMs: +(stepMs / Math.max(1, steps)).toFixed(3), maxStepMs: +maxStep.toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1048576),
    lagSeconds: +Math.max(0, (now - due) / 1000).toFixed(2), checkpointBytes };
  const tmp = store.file('.status.tmp'); fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, store.file('status.json'));
  stepMs = 0; steps = 0; maxStep = 0; cpuMark = process.cpuUsage(); wallMark = now;
  return s;
}

// Frames for the web server (when forked by it): actors every 0.6 s, a summary every
// 5 s, plants every 15 s, fields every 20 s, body plans once per new creature.
const publish = typeof process.send === 'function';
const known = new Set();
function frames() {
  if (!publish) return;
  const tick = world.tick;
  if (tick % 3 === 0) {
    const fresh = world.creatures.filter(c => !known.has(c.id));
    for (const c of fresh) known.add(c.id);
    if (fresh.length) process.send({ type: 'frame', kind: 'bodies', bytes: bodiesFrame(world, fresh) });
    process.send({ type: 'frame', kind: 'actors', bytes: actorsFrame(world) });
  }
  if (tick % 25 === 0) process.send({ type: 'summary', data: summary(world) });
  if (tick % 75 === 0) process.send({ type: 'frame', kind: 'plants', bytes: plantsFrame(world) });
  if (tick % 100 === 0) process.send({ type: 'frame', kind: 'fields', bytes: fieldsFrame(world) });
  if (tick % 300 === 0) { const alive = new Set(world.creatures.map(c => c.id)); for (const id of known) if (!alive.has(id)) known.delete(id); }
}
process.on('message', m => {
  if (m?.type === 'bodies') process.send({ type: 'reply', id: m.id, bytes: bodiesFrame(world, world.creatures) });
  if (m?.type === 'immigrate') { // the demiurge's checked designs and weather: immigrants are carried in, the weather starts
    const results = (m.designs || []).map(d => { const g = genomeOf(d, world.rng); return g ? world.immigrate(g, d.count, d.region, { by: 'demiurge' }) : null; });
    const weather = m.weather ? world.startWeather(m.weather, 'demiurge') : false;
    process.send({ type: 'reply', id: m.id, bytes: Buffer.from(JSON.stringify({ results, weather })) });
  }
  if (m?.type === 'need') { // bodies a viewer is missing, by id
    const want = new Set(m.ids || []);
    process.send({ type: 'reply', id: m.id, bytes: bodiesFrame(world, world.creatures.filter(c => want.has(c.id))) });
  }
  if (m?.type === 'timelapse') process.send({ type: 'reply', id: m.id, bytes: recorder.pack(24, world.t) });
  if (m?.type === 'museum') { // portraits of every established species the world still remembers, alive or as spores
    const out = {};
    for (const s of world.spores) if (s.species) out[s.species] = portrait(s.g);
    for (const s of world.species.values()) if (s.established || s.immigrant) out[s.id] = portrait(s.sample);
    process.send({ type: 'reply', id: m.id, bytes: Buffer.from(JSON.stringify({ t: world.t, portraits: out })) });
  }
});

let due = performance.now(), lastSave = due, lastStatus = due, ending = false;
const timer = setInterval(() => {
  if (ending) return;
  const now = performance.now();
  for (let batch = 0; due <= now && batch < 10; batch++) {
    const s = performance.now(); advance(world); const e = performance.now() - s;
    stepMs += e; steps++; if (e > maxStep) maxStep = e;
    due += 1000 / HZ;
    frames();
  }
  if (now - lastStatus >= 10000) { const s = status(); lastStatus = now; if (env.EPOCHS_VERBOSE) console.log(JSON.stringify(s)); }
  if (now - lastSave >= SAVE_EVERY) { checkpointBytes = save(); lastSave = now; }
}, 1000 / HZ);

function stop() {
  if (ending) return; ending = true; clearInterval(timer);
  try { save(); } catch (error) { console.error(error); process.exitCode = 1; }
  store.unlock(); process.exit(process.exitCode || 0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('disconnect', stop);
console.log(`NIMA: Epochs engine running: world time ${(world.t / 3600).toFixed(2)} h, ${world.creatures.length} creatures, data ${store.directory}`);
