// Summarise run reports: node scripts/summarize.mjs runs/a runs/b ...
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
const rows = [];
for (const dir of dirs) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  const h = r.hourly, last = h.at(-1), half = h.slice(Math.floor(h.length / 2));
  const mean = f => half.reduce((s, x) => s + f(x), 0) / half.length;
  const first = r.hourly.find(x => x.traits) ? r.hourly[0].traits : {};
  rows.push({
    run: path.basename(dir), seed: r.seed, days: +(r.hours / 24).toFixed(1),
    wallMin: +(r.wallSeconds / 60).toFixed(1), msPerStep: +r.msPerStep.toFixed(3), cpuPct: +(r.msPerStep * 5 / 10).toFixed(2), rssMB: Math.round(r.rssMB),
    drift: r.matterDrift.toExponential(1),
    producers: Math.round(mean(x => x.roles.producer)), grazers: Math.round(mean(x => x.roles.grazer)),
    predators: Math.round(mean(x => x.roles.predator)), scavengers: Math.round(mean(x => x.roles.scavenger)),
    minAnimals: Math.min(...h.map(x => x.animals)), species: last.species, established: r.established, extinct: r.extinctEstablished,
    epochs: r.epoch, meteors: r.meteors, volcanoes: r.volcanoes, epidemics: r.eventsByType.epidemic || 0,
    firstPredatorH: r.firsts.predator ? +(r.firsts.predator / 3600).toFixed(1) : null,
    cycles: r.dynamics.cycles, lag: r.dynamics.lag,
    traitsStart: first, traitsEnd: last.traits
  });
}
const fmt = v => typeof v === 'object' && v ? JSON.stringify(v) : String(v);
const keys = ['run', 'seed', 'days', 'wallMin', 'msPerStep', 'cpuPct', 'rssMB', 'drift', 'producers', 'grazers', 'predators', 'scavengers', 'minAnimals',
  'species', 'established', 'extinct', 'epochs', 'meteors', 'volcanoes', 'epidemics', 'firstPredatorH', 'cycles'];
console.log('| ' + keys.join(' | ') + ' |');
console.log('|' + keys.map(() => '---').join('|') + '|');
for (const r of rows) console.log('| ' + keys.map(k => fmt(r[k])).join(' | ') + ' |');
for (const r of rows) {
  const t = r.traitsEnd, s = r.traitsStart;
  console.log(`\n${r.run}: animal body start→end ` + ['bite', 'armor', 'thrust', 'eye', 'glow', 'fat', 'mass', 'diet', 'modules']
    .map(k => `${k} ${(s[k] ?? 0).toFixed(2)}→${(t[k] ?? 0).toFixed(2)}`).join(', ') + `; predator lag ${r.lag.lag * 10} min r=${r.lag.r.toFixed(2)}`);
}
