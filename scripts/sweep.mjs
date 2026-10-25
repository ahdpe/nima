// Parameter sweep: short runs, one line per setting, judged by coexistence.
// node scripts/sweep.mjs --hours=12 --seeds=1,2 "BITE_RATE=0.08,0.12" "MATURITY_MASS=150,300"
import { World, HZ } from '../lib/world.mjs';
import { P } from '../lib/params.mjs';
const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const axes = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => { const [k, v] = a.split('='); if (!(k in P)) throw Error(k); return [k, v.split(',').map(Number)]; });
const hours = Number(flags.hours || 12), seeds = (flags.seeds || '731947').split(',').map(Number);
const base = { ...P };
const combos = axes.reduce((acc, [k, vs]) => acc.flatMap(c => vs.map(v => ({ ...c, [k]: v }))), [{}]);
for (const combo of combos) for (const seed of seeds) {
  Object.assign(P, base, combo);
  const w = new World({ seed }); const t0 = performance.now();
  const rows = [];
  for (let h = 0; h < hours; h++) { for (let i = 0; i < HZ * 3600; i++) w.step(); rows.push(w.history.at(-1)); }
  const g = rows.map(r => r.roles.grazer + r.roles.predator + r.roles.scavenger), pl = rows.map(r => r.roles.producer);
  const withAnimals = g.filter(v => v >= 10).length / rows.length;
  const half = rows.slice(Math.floor(rows.length / 2)), avg = f => Math.round(half.reduce((m, r) => m + f(r), 0) / half.length);
  console.log(`${JSON.stringify(combo)} seed=${seed} animals≥10: ${(withAnimals * 100).toFixed(0)}% | animals ${Math.min(...g)}–${Math.max(...g)} last ${g.at(-1)} | plants ${Math.min(...pl)}–${Math.max(...pl)} last ${pl.at(-1)} | 2nd-half mean P${avg(r => r.roles.producer)} G${avg(r => r.roles.grazer)} C${avg(r => r.roles.predator)} S${avg(r => r.roles.scavenger)} bite ${(half.reduce((m, r) => m + r.traits.bite, 0) / half.length).toFixed(2)} eye ${(half.reduce((m, r) => m + r.traits.eye, 0) / half.length).toFixed(2)} thr ${(half.reduce((m, r) => m + r.traits.thrust, 0) / half.length).toFixed(2)} diet ${(half.reduce((m, r) => m + r.traits.diet, 0) / half.length).toFixed(2)} plantArm ${(half.reduce((m, r) => m + (r.flora?.armor || 0), 0) / half.length).toFixed(2)} | maxC ${Math.max(...rows.map(r => r.roles.predator))} algae ${Math.round(half.reduce((m, r) => m + (r.algae || 0), 0) / half.length)} | germ ${w.counters.germinated} est ${w.counters.established} | ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}
