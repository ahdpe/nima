// Accelerated headless run: every step is computed in order, nothing skipped.
// node scripts/run.mjs --days=7 --seed=731947 [--set PMAX=0.06] [--meteor-day=3] [--out=runs/name]
import fs from 'node:fs';
import path from 'node:path';
import { serialize } from 'node:v8';
import { gzipSync } from 'node:zlib';
import { World, HZ } from '../lib/world.mjs';
import { P } from '../lib/params.mjs';
import { predatorPreyCycles, lagCorrelation } from '../lib/analysis.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const sets = [].concat(process.argv.slice(2).filter(a => a.startsWith('--set=')).map(a => a.slice(6)));
for (const kv of sets) { const [k, v] = kv.split('='); if (!(k in P)) throw Error(`Unknown parameter ${k}`); P[k] = Number(v); }
const seed = Number(args.seed || 731947);
const hours = Number(args.hours || 0) + Number(args.days || 0) * 24 || 24;
const every = Number(args.every || 2); // hours between printed lines
const out = args.out || `runs/s${seed}-${hours}h`;
fs.mkdirSync(out, { recursive: true });

const world = new World({ seed });
const meteorAt = args['meteor-day'] ? Number(args['meteor-day']) * 86400 : null;
const hourly = [], tenMin = [];
const t0 = performance.now();
let stepMs = 0, steps = 0, maxStep = 0, lastSeq = world.eventSeq;
const allEvents = [...world.events];
const slow = []; // slowest steps with what ran on them
const cpu0 = process.cpuUsage();
const pad = (v, n) => String(v).padStart(n);
const fmt = (h, ms) => {
  const r = h.roles, tr = h.traits;
  return `${pad((h.t / 3600).toFixed(0), 4)}h ep${h.epoch} n=${pad(h.n, 4)} P${pad(r.producer, 4)} G${pad(r.grazer, 4)} C${pad(r.predator, 3)} S${pad(r.scavenger, 3)} ` +
    `sp=${pad(h.species, 3)}/${pad(h.established, 3)} inf=${pad(h.infected, 3)} light=${h.light.toFixed(2)} clim=${h.climate.toFixed(2)} ` +
    `| algae=${Math.round(h.algae)} plant arm=${h.flora.armor.toFixed(2)} | bite=${tr.bite.toFixed(2)} arm=${tr.armor.toFixed(2)} thr=${tr.thrust.toFixed(2)} eye=${tr.eye.toFixed(2)} glow=${tr.glow.toFixed(2)} diet=${tr.diet.toFixed(2)} mod=${tr.modules.toFixed(1)} | ${ms.toFixed(2)}ms`;
};
const loud = new Set(['first_predator', 'first_scavenger', 'epoch', 'recovery', 'meteor', 'meteor_clear', 'eruption', 'epidemic', 'ice_age_start', 'ice_age_end', 'germination']);
for (let hour = 1; hour <= hours; hour++) {
  const hs = performance.now();
  for (let i = 0; i < HZ * 3600; i++) {
    if (meteorAt !== null && world.t >= meteorAt && !world.meteors) world.impact();
    const s = performance.now(); world.step(); const e = performance.now() - s;
    stepMs += e; steps++; if (e > maxStep) maxStep = e;
    if (e > 20) { slow.push({ ms: +e.toFixed(1), tick: world.tick, second: world.tick % HZ === 0, minute: world.tick % (HZ * 60) === 0, census: world.tick % (HZ * 600) === 0, n: world.creatures.length }); slow.sort((a, b) => b.ms - a.ms); slow.length = Math.min(slow.length, 8); }
    if (world.tick % (HZ * 600) === 0) { const h = world.history.at(-1); tenMin.push({ t: h.t, ...h.roles, animals: h.animals, species: h.species, established: h.established, light: +h.light.toFixed(3), infected: h.infected }); }
  }
  const h = world.history.at(-1);
  hourly.push({ ...h, msPerStep: (performance.now() - hs) / (HZ * 3600) });
  for (const e of world.events) if (e.seq > lastSeq) {
    allEvents.push(e);
    if (loud.has(e.type)) console.log(`        · ${(e.t / 3600).toFixed(1)}h ${e.type} ${JSON.stringify({ ...e, t: undefined, type: undefined, epoch: undefined, seq: undefined })}`);
  }
  lastSeq = world.eventSeq;
  if (hour % every === 0 || hour === hours) console.log(fmt(h, hourly.at(-1).msPerStep));
  if (world.creatures.length === 0) { console.log('Empty world'); }
}
const roles = {};
for (const s of world.species.values()) if (s.established) roles[s.role] = (roles[s.role] || 0) + 1;
const established = [...world.species.values()].filter(s => s.established);
const prey = tenMin.map(r => r.grazer), pred = tenMin.map(r => r.predator);
const dynamics = { ...predatorPreyCycles(prey, pred), lag: lagCorrelation(prey, pred) };
const report = {
  dynamics,
  seed, hours, params: { ...P }, slowSteps: slow, cpuSeconds: (process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1e6, wallSeconds: (performance.now() - t0) / 1000, steps, msPerStep: stepMs / steps, maxStepMs: maxStep,
  rssMB: process.memoryUsage().rss / 1048576, counters: world.counters, epoch: world.epoch, meteors: world.meteors, volcanoes: world.volcanoes,
  matterDrift: world.matter() - world.matter0, matter0: world.matter0,
  established: established.length, extinctEstablished: established.filter(s => s.count <= 0).length, rolesEverEstablished: roles,
  firsts: world.firsts, events: allEvents.length, hourly,
  eventsByType: allEvents.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {}),
  fossils: world.fossilSeq,
  living: established.filter(s => s.count > 0).map(s => ({ id: s.id, parent: s.parent, count: s.count, peak: s.peak, role: s.role, bornH: +(s.born / 3600).toFixed(1),
    modules: s.sample.modules.map(m => m.t).join(''), diet: +s.sample.diet.toFixed(2) })).sort((a, b) => b.count - a.count)
};
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(allEvents));
fs.writeFileSync(path.join(out, 'series.json'), JSON.stringify(tenMin));
fs.writeFileSync(path.join(out, 'world.ckpt.gz'), gzipSync(serialize(world.export()), { level: 1 }));
console.log(`done ${hours}h in ${report.wallSeconds.toFixed(0)}s, ${report.msPerStep.toFixed(3)} ms/step (max ${maxStep.toFixed(1)}), rss ${report.rssMB.toFixed(0)} MB, matter drift ${report.matterDrift.toExponential(2)}`);
console.log(`established species ${report.established} (extinct ${report.extinctEstablished}) roles ${JSON.stringify(roles)} firsts ${JSON.stringify(world.firsts)}`);
console.log('counters', JSON.stringify(world.counters));
console.log('dynamics', JSON.stringify(dynamics));
console.log('cpu', report.cpuSeconds.toFixed(0), 's of', report.wallSeconds.toFixed(0), 's wall; slowest', JSON.stringify(slow.slice(0, 4)));
console.log('living', JSON.stringify(report.living.slice(0, 8)));
