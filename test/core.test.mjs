import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { World, HZ } from '../lib/world.mjs';
import { Rng } from '../lib/rng.mjs';
import { WORLD } from '../lib/environment.mjs';
import { plantGenome, grazerGenome, mutate, crossover, cloneGenome, validGenome, phenotype, spectral, MAX_MODULES, SIG } from '../lib/genome.mjs';

// Canonical digest: JSON keeps every double exactly; typed arrays become plain arrays.
const digest = w => createHash('sha256').update(JSON.stringify(w.export(), (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v)).digest('hex');

test('matter is conserved through feeding, death, disease and catastrophes', () => {
  const w = new World({ seed: 11, plants: 600, grazers: 40 });
  for (let i = 0; i < HZ * 600; i++) w.step();
  w.eruption(100, 100); w.impact(300, 300);
  for (let i = 0; i < HZ * 600; i++) w.step();
  assert.ok(Math.abs(w.matter() - w.matter0) / w.matter0 < 1e-9, `drift ${w.matter() - w.matter0}`);
});

test('a restored checkpoint continues exactly like the uninterrupted world', () => {
  const a = new World({ seed: 5, plants: 500, grazers: 40 });
  for (let i = 0; i < HZ * 157; i++) a.step();
  const b = World.restore(deserialize(serialize(a.export())));
  for (let i = 0; i < HZ * 300; i++) { a.step(); b.step(); }
  assert.equal(digest(a), digest(b));
});

test('the same seed gives the same history', () => {
  const a = new World({ seed: 9, plants: 300, grazers: 20 }), b = new World({ seed: 9, plants: 300, grazers: 20 });
  for (let i = 0; i < HZ * 120; i++) { a.step(); b.step(); }
  assert.equal(digest(a), digest(b));
});

test('mutation and recombination keep genomes valid and bounded', () => {
  const r = new Rng(3);
  let g = grazerGenome(r), h = plantGenome(r), longest = 0;
  for (let i = 0; i < 4000; i++) {
    g = mutate(i % 7 ? cloneGenome(g) : crossover(g, h, r), r, 3);
    assert.ok(validGenome(g)); longest = Math.max(longest, g.modules.length);
    const p = phenotype(g);
    assert.ok(p.mass > 0 && p.cap > 0 && p.upkeep > 0 && Number.isFinite(p.range));
  }
  assert.ok(longest <= MAX_MODULES);
});

test('grazing never kills a producer outright; predation kills animals', () => {
  const w = new World({ seed: 2, plants: 0, grazers: 0 });
  const r = new Rng(4);
  const plant = w.spawn(plantGenome(r), 50, 50, null, 3);
  const grazer = w.spawn(grazerGenome(r), 51, 50, null, 1);
  for (let i = 0; i < 400; i++) w.bite(grazer, plant, 0);
  assert.ok(!plant.dead && plant.e > 0);
  const big = grazerGenome(r); big.modules.push({ t: 1, s: 1.4, a: 0 }); big.diet = .9;
  const hunter = w.spawn(big, 52, 50, null, 1);
  for (let i = 0; i < 400 && !grazer.dead; i++) w.bite(hunter, grazer, 0);
  assert.ok(grazer.dead);
});

test('body plans: radial bodies work all round, shape sets drag and turning, plans stay valid', () => {
  const rng = new Rng(5), g = grazerGenome(rng);
  g.modules = [{ t: 1, s: .4, a: Math.PI }, { t: 2, s: .5, a: 0 }]; // mouth behind, cilia in front
  const bi = phenotype(g), rad = phenotype({ ...g, sym: 5 });
  assert.ok(Math.abs(bi.jaw - .4 * .25) < 1e-9 && Math.abs(rad.jaw - .4) < 1e-9, 'a radial mouth has no back');
  assert.ok(Math.abs(rad.push - .5 * .6) < 1e-9, 'a radial body swims by pulsing');
  assert.ok(phenotype({ ...g, elong: 2.2 }).drag < bi.drag && phenotype({ ...g, elong: 2.2 }).turn < bi.turn, 'long bodies slip through, turn slowly');
  assert.ok(Math.abs(bi.drag - 1) < 1e-9 && Math.abs(bi.turn - 1) < 1e-9, 'the default plan keeps the old physics');
  const t = phenotype({ ...g, modules: [...g.modules, { t: 7, s: .5, a: 0 }, { t: 8, s: .5, a: 1 }] });
  assert.ok(t.reach > 1 && t.drag > bi.drag && t.defense > bi.defense);
  let x = cloneGenome(g); const seen = new Set();
  for (let i = 0; i < 20000; i++) { x = mutate(x, rng, 3); seen.add(x.sym); assert.ok(validGenome(x)); }
  assert.ok(seen.has(0) && [...seen].some(s => s >= 3), 'symmetry changes now and then');
});

test('a world saved before body plans restores as bilateral bodies with the old signatures', () => {
  const w = new World({ seed: 21, plants: 300, grazers: 30 });
  for (let i = 0; i < HZ * 300; i++) w.step();
  const s = deserialize(serialize(w.export()));
  const old = g => { delete g.sym; delete g.elong; delete g.seg; delete g.form; delete g.pig; delete g.leaf; };
  for (const c of s.creatures) old(c.g);
  for (const x of s.species) { old(x.sample); x.rep = x.rep.slice(0, 12); }
  for (const x of s.spores) old(x.g);
  delete s.layout; s.layout = 1;
  const r = World.restore(s);
  assert.ok(r.creatures.every(c => c.g.sym === 0 && c.g.elong === 1.3 && c.g.seg === 1 && c.g.form === 0 && c.sig.length === SIG));
  assert.ok([...r.species.values()].every(x => x.rep.length === SIG));
  for (let i = 0; i < HZ * 60; i++) r.step();
});

test('segments and growth forms: chains are cheaper per segment, bushes stand in the light', () => {
  const rng = new Rng(9), a = grazerGenome(rng), p1 = phenotype(a), p3 = phenotype({ ...a, seg: 3 });
  assert.ok(p3.seg === 3 && Math.abs(p3.mass - 3 * p1.mass) < 1e-9 && p3.upkeep < 3 * p1.upkeep && p3.turn < p1.turn);
  const pl = plantGenome(rng); assert.equal(phenotype({ ...pl, seg: 4 }).seg, 1, 'plants have no segments');
  assert.equal(phenotype({ ...a, form: 2 }).form, 0, 'animals have no growth form');
  const w = new World({ seed: 31, plants: 0, grazers: 0 });
  const put = form => { const g = plantGenome(new Rng(3)); g.form = form; return w.spawn(g, 2, WORLD / 2, null, 2); }; // noon, mid-belt
  for (let i = 0; i < 6; i++) put(0);
  const bush = put(2), rosette = w.creatures.find(c => c.p.form === 0);
  for (let i = 0; i < HZ * 3; i++) w.step();
  assert.ok(rosette.intake[0] > 0 && bush.intake[0] / bush.p.photo > 2 * rosette.intake[0] / rosette.p.photo, 'the bush is not shaded by the rosettes');
});

test('pigments and leaves: green is neutral, red pays in the deep, broad leaves feed grazers', () => {
  for (const s of [0, .3, .7, 1]) assert.equal(spectral(0, s), 1, 'green, as before');
  assert.ok(spectral(.7, 0) > 1.15 && spectral(.7, 1) < .85, 'red: better deep, worse shallow');
  const best = s => { let b = 0, v = -1; for (let p = 0; p <= 1.0001; p += .05) if (spectral(p, s) > v) { v = spectral(p, s); b = p; } return b; };
  assert.ok(best(0) > .6 && best(.5) > .2 && best(.5) < .5 && best(1) === 0, 'red deep, brown on the slopes, green in the shallows');
  const g = plantGenome(new Rng(4)), broad = phenotype({ ...g, leaf: 1 }), narrow = phenotype({ ...g, leaf: 0 }), plain = phenotype(g);
  assert.ok(plain.leafLight === 1 && plain.grazed === 1);
  assert.ok(broad.leafLight > 1 && broad.grazed > 1 && narrow.leafLight < 1 && narrow.grazed < 1);
});

test('more growth forms: kelp overtops bushes, colonies float, diatoms are shelled, runners spread', () => {
  const w = new World({ seed: 41, plants: 0, grazers: 0 });
  const put = (form, x, y) => { const g = plantGenome(new Rng(3)); g.form = form; return w.spawn(g, x, y, null, 2); };
  for (let i = 0; i < 6; i++) put(2, 2, WORLD / 2);
  const kelp = put(3, 2, WORLD / 2), bush = w.creatures.find(c => c.p.form === 2);
  // over deep water a floating colony sees more light than a rosette beside it
  let deep = 0; for (let c = 0; c < w.shallow.length; c++) if (w.shallow[c] < .05) { deep = c; break; }
  const dx = (deep % (WORLD / 4)) * 4 + 2, dy = Math.floor(deep / (WORLD / 4)) * 4 + 2;
  const colony = put(5, dx, dy), rosette = put(0, dx + 1, dy);
  for (let i = 0; i < HZ * 3; i++) w.step();
  assert.ok(kelp.intake[0] / kelp.p.photo > 2 * bush.intake[0] / bush.p.photo, 'kelp is not shaded by the bushes');
  assert.ok(colony.intake[0] / colony.p.photo > rosette.intake[0] / rosette.p.photo * 1.2, 'the colony floats into the light');
  const g = plantGenome(new Rng(5)), d = phenotype({ ...g, form: 6 }), r = phenotype(g);
  assert.ok(d.defense > r.defense + .3 && d.grazed < r.grazed && d.mass > r.mass, 'a glass shell protects and weighs');
});

test('weather: storms dim the water and stir it, red tides poison, currents brighten a band, blooms feed; matter is kept', () => {
  const w = new World({ seed: 51, plants: 300, grazers: 30 });
  for (let i = 0; i < HZ * 60; i++) w.step();
  const m0 = w.matter();
  w.environment(); const calm = w.globalLight;
  w.weather = { kind: 'storm', at: w.t - 3600, until: w.t + 3600, dir: 1 }; w.environment();
  assert.ok(w.globalLight < calm * .7, 'a storm darkens');
  w.weather = { kind: 'red_tide', at: w.t, until: w.t + 4 * 3600, x: 200, y: 200, r: 60 };
  for (let i = 0; i < HZ * 1800; i++) w.step();
  assert.ok(w.T[Math.floor(200 / 4) * (w.T.length ** .5) + 50] > .2, 'the red tide poisons its patch');
  const g = w.T.length ** .5, centre = 75 * g + 75, before = w.N[centre], s0 = w.sediment;
  w.feed(302, 302, 80, 300); // what a bloom does each second, here in one go
  assert.ok(w.N[centre] > before + .2 && Math.abs(s0 - w.sediment - 300) < 1e-9, 'a bloom wells nutrients up from the sediment');
  w.weather = { kind: 'warm_current', at: w.t - 3600, until: w.t + 20 * 3600, x0: 100 }; w.environment();
  const bx = w.currentX(), col = Math.floor(bx / 4), far = (col + 120) % w.lightCol.length;
  assert.ok(w.lightCol[col] > w.lightCol[far] * 0 && w.weatherStrength() === 1);
  for (let i = 0; i < HZ * 60; i++) w.step();
  assert.ok(Math.abs(w.matter() - m0) / m0 < 1e-9, 'matter is kept through weather');
});

test('a bitten animal with light organs flashes, and the startled attacker sometimes lets go', () => {
  const w = new World({ seed: 61, plants: 0, grazers: 0 });
  const make = glow => { const g = grazerGenome(new Rng(8)); if (glow) g.modules.push({ t: 5, s: .4, a: 1 }); return w.spawn(g, 100, 100, null, 50); };
  const hunter = make(false); hunter.g.diet = .9; hunter.p.jaw = 2;
  let escaped = 0; const prey = make(true);
  for (let i = 0; i < 400; i++) { const e = prey.e; w.bite(hunter, prey, 0, .4); if (prey.e > e - .01 && !prey.dead) escaped++; prey.e = 50; }
  assert.ok(escaped > 60 && escaped < 250, `escapes ${escaped}`);
  assert.ok(prey.flash > 0 || prey.glow >= 0);
  const dull = make(false); let held = 0; for (let i = 0; i < 100; i++) { const e = dull.e; w.bite(hunter, dull, 0, .4); if (dull.e < e) held++; dull.e = 50; }
  assert.equal(held, 100, 'without light there is no flash');
});
