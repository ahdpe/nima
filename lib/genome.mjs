import { P } from './params.mjs';
// Heritable body plan and nervous system. A genome lists body modules; every
// ability comes from a module, and every module adds mass and upkeep.
export const MODULE = Object.freeze({ PHOTO: 0, MOUTH: 1, FLAGELLUM: 2, ARMOR: 3, EYE: 4, PHOTOPHORE: 5, FAT: 6, TENTACLE: 7, SPINE: 8 });
export const MODULE_NAMES = ['photo', 'mouth', 'flagellum', 'armor', 'eye', 'photophore', 'fat', 'tentacle', 'spine'];
export const MODULE_TYPES = MODULE_NAMES.length;
// Body plan: sym 0 is bilateral, 3..8 radial with that many rays; elong is the length/width
// of a bilateral body. Bodies from before plans existed are bilateral with elong 1.3.
export const ELONG_MIN = .7, ELONG_MAX = 2.4, ELONG_DEFAULT = 1.3;
// seg 1..5: an animal's body repeats its organs in a chain of segments. form: how a plant grows —
// 0 rosette; 1 filament (spreads over three field cells); 2 bush (tall, shades the low plants);
// 3 kelp (tallest: long fronds above everything, a heavy stem); 4 runner (a creeping stolon over five
// cells that sends its young along it; thin); 5 floating colony (a Volvox sphere near the surface:
// full light even over the deep, but keeping afloat costs and it has no protection); 6 diatom (a glass
// shell: cheap protection, heavy).
export const SEG_MAX = 5, FORM = Object.freeze({ ROSETTE: 0, FILAMENT: 1, BUSH: 2, KELP: 3, RUNNER: 4, COLONY: 5, DIATOM: 6 }), FORMS = 7;
// pig 0..1: the pigment of the chloroplasts, green (0) through brown to red. Like real red algae,
// a red pigment catches the blue light that reaches deep water and wastes the full light of the
// shallows. leaf 0..1: a plant's blades, narrow ribbons (0) to broad round leaves (1).
// Bodies from before these genes are green (0) with ordinary leaves (.5): nothing changes for them.
export const LEAF_DEFAULT = .5;
// Light used per unit of chloroplast at shallowness s: green is neutral everywhere; a pigment
// gains in dim deep water and costs in bright shallows; the best pigment is about .7·(1 − s).
export function spectral(pig, s) { return 1 + pig * (1 - s) * P.PIGMENT_GAIN - pig * pig * P.PIGMENT_COST; }
export const MAX_MODULES = 12;
export const MIN_SIZE = 0.1, MAX_SIZE = 1.5;

// Brain: 17 sensory inputs, 8 recurrent hidden units, 4 motor outputs, plus
// direct input→output reflex connections.
export const NI = 17, NH = 8, NO = 4;
export const IH = 0, HH = IH + NH * NI, BH = HH + NH * NH, HO = BH + NH, IO = HO + NO * NH, BO = IO + NO * NI;
export const BRAIN_SIZE = BO + NO;
export const IN = Object.freeze({ PLANT_A: 0, PLANT_P: 1, MEAT_A: 2, MEAT_P: 3, THREAT_A: 4, THREAT_P: 5,
  KIN_A: 6, KIN_P: 7, GLOW_A: 8, GLOW_P: 9, LIGHT: 10, ENERGY: 11, HURT: 12, CLOCK: 13, TOUCH: 14, ALGAE: 15, ALGAE_A: 16 });
export const OUT = Object.freeze({ THRUST: 0, TURN: 1, BITE: 2, GLOW: 3 });

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const TAU = Math.PI * 2;

// Body at a given growth scale: juveniles carry every module at a fraction of its size.
// Where an organ sits matters: a mouth bites and an eye sees best at the front,
// a flagellum pushes best from the rear. An organ facing the wrong way still
// costs its full upkeep but works at a quarter of its strength.
// A radial body has no front: its mouths and eyes work all round, but it swims by pulsing,
// at .6 of the push, and it turns on the spot. Like a jellyfish it is mostly water: cheaper
// to keep and to move.
const front = a => .25 + .375 * (1 + Math.cos(a)), rear = a => .25 + .375 * (1 - Math.cos(a));
// Segments: every segment carries the whole set of organs and a cell body of its own; a chain
// is cheaper to keep per segment and slips through the water like a longer body, but it is
// heavier (it matures later, its young cost more) and turns slowly.
export function phenotype(g, scale = 1) {
  // Segments and growth forms belong to animals and plants respectively; for the other they mean nothing.
  const acts = g.modules.some(m => m.t === MODULE.FLAGELLUM || m.t === MODULE.MOUTH);
  const t = new Float64Array(MODULE_TYPES), radial = g.sym > 0, k = acts ? g.seg || 1 : 1;
  let jaw = 0, push = 0, sight = 0;
  for (const m of g.modules) {
    const s = m.s * scale * k; t[m.t] += s;
    if (m.t === MODULE.MOUTH) jaw += radial ? s : s * front(m.a);
    else if (m.t === MODULE.FLAGELLUM) push += radial ? s * .6 : s * rear(m.a);
    else if (m.t === MODULE.EYE) sight += radial ? s : s * front(m.a);
  }
  const tent = t[MODULE.TENTACLE], spine = t[MODULE.SPINE], elong = (radial ? ELONG_DEFAULT : g.elong) * (1 + .15 * (k - 1));
  let total = 0; for (const v of t) total += v;
  const plant = total > 0 && t[MODULE.PHOTO] / total >= .5, form = acts ? 0 : g.form || 0;
  const structure = form === FORM.BUSH ? P.STEM_MASS : form === FORM.KELP ? P.KELP_MASS : form === FORM.RUNNER ? P.RUNNER_MASS : form === FORM.DIATOM ? P.SHELL_MASS : 0;
  const mass = 0.25 * k + total + structure * t[MODULE.PHOTO]; // stems, stolons and glass shells weigh
  const eye = t[MODULE.EYE];
  return {
    mass, total,
    photo: t[MODULE.PHOTO], bite: t[MODULE.MOUTH], thrust: t[MODULE.FLAGELLUM], armor: t[MODULE.ARMOR],
    eye, glow: t[MODULE.PHOTOPHORE], fat: t[MODULE.FAT], jaw, push, tent, spine,
    // Water resistance: a long body slips through, a round one or a radial bell less so;
    // tentacles and spines drag. Long bodies turn slowly, radial ones on the spot.
    drag: (radial ? 1.15 : 1.9 / (.6 + elong)) + .3 * tent + .2 * spine,
    turn: (radial ? 2.2 : 1.6 / (.3 + elong)) / (1 + .25 * (k - 1)),
    seg: k, form,
    pig: t[MODULE.PHOTO] > 0 ? g.pig : 0,
    // Broad leaves catch more light and are grazed more; narrow ribbons the reverse (plants only).
    leafLight: plant && !acts ? 1 + P.LEAF_LIGHT * (g.leaf - LEAF_DEFAULT) * 2 : 1,
    grazed: plant && !acts ? (1 + P.LEAF_GRAZE * (g.leaf - LEAF_DEFAULT) * 2) * (form === FORM.DIATOM ? P.SHELL_GRAZE : form === FORM.RUNNER ? P.RUNNER_GRAZE : 1) : 1, // a grazer gets one node of a runner
    reach: P.TENTACLE_REACH * tent,
    radius: 1.1 * Math.sqrt(mass),
    range: eye > 0 ? 10 + 45 * (1 - Math.exp(-1.6 * sight)) : 5,
    cap: 3 * mass + 8 * t[MODULE.FAT],
    // Bulk makes an animal hard to kill; a plant is protected by armour (thorns), not by size.
    // A filament is thin: its armour protects half as well.
    defense: (form === FORM.FILAMENT || form === FORM.RUNNER ? 1 : 2) * t[MODULE.ARMOR] + spine + (form === FORM.DIATOM ? P.SHELL_DEFENSE : 0) + (plant ? .05 : .25) * mass,
    plantFrac: total > 0 ? t[MODULE.PHOTO] / total : 0,
    // Idle respiration. Motion and light emission are charged when used.
    stroke: radial ? P.RADIAL_ECONOMY : 1,                // cost of motion per unit of thrust
    upkeep: (P.BASE_UPKEEP * mass * (radial ? P.RADIAL_ECONOMY : 1) + P.EYE_UPKEEP * eye + P.MOUTH_UPKEEP * t[MODULE.MOUTH] + P.MUSCLE_UPKEEP * t[MODULE.FLAGELLUM] + P.GLOW_UPKEEP * t[MODULE.PHOTOPHORE] + P.FAT_UPKEEP * t[MODULE.FAT]
      + P.TENTACLE_UPKEEP * tent + P.SPINE_UPKEEP * spine + (form === FORM.COLONY ? P.FLOAT_UPKEEP * t[MODULE.PHOTO] : 0)) * (1 - P.SEGMENT_ECONOMY * (k - 1)),
    acts
  };
}

// Compact ecological signature: what the body is made of, what it digests,
// and four neutral markers that drift freely and measure relatedness.
export const SIG = 22;
export function signature(g, p = phenotype(g)) {
  const s = new Float32Array(SIG);
  s[0] = p.photo * .5; s[1] = p.bite * .5; s[2] = p.thrust * .5; s[3] = p.armor * .5;
  s[4] = p.eye * .5; s[5] = p.glow * .5; s[6] = p.fat * .5; s[7] = g.diet;
  for (let i = 0; i < 4; i++) s[8 + i] = g.markers[i] * .6;
  // Body plan: a change of symmetry alone makes a new species.
  // Plants do not move, so symmetry and length mean nothing for them and do not split them.
  s[12] = p.tent * .5; s[13] = p.spine * .5;
  if (p.acts) { s[14] = g.sym > 0 ? .35 + .02 * g.sym : 0; s[15] = (g.elong - ELONG_DEFAULT) * .15; s[16] = (g.seg - 1) * .12; }
  else { s[17] = p.form === FORM.FILAMENT ? .3 : 0; s[18] = p.form === FORM.BUSH ? .3 : 0; s[20] = (g.leaf - LEAF_DEFAULT) * .3; } // a new growth form is a new species
  s[19] = p.photo > 0 ? g.pig * .4 : 0; // a green and a red lineage part as species
  if (!p.acts && p.form >= FORM.KELP) s[21] = .3 * (p.form - 2); // kelp, runner, colony and diatom differ from all others
  return s;
}
export function distance(a, b) { let d = 0; for (let i = 0; i < SIG; i++) d += (a[i] - b[i]) ** 2; return Math.sqrt(d); }

// One-time migration for genomes from before placement mattered, when organ
// angles were neutral: mouths and eyes move into the front quarter and flagella
// into the rear quarter, keeping their relative order. Nothing physical changes
// for the bodies: the angles had no effect until now.
const wrap = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
export function settleLayout(g) {
  for (const m of g.modules) {
    if (m.t === MODULE.MOUTH || m.t === MODULE.EYE) m.a = wrap(m.a) * .25;
    else if (m.t === MODULE.FLAGELLUM) m.a = wrap(Math.PI + wrap(m.a - Math.PI) * .25);
  }
  return g;
}

// Genomes written before body plans existed: bilateral, of today's average length.
export function settlePlan(g) { if (g.sym === undefined) { g.sym = 0; g.elong = ELONG_DEFAULT; } if (g.seg === undefined) { g.seg = 1; g.form = 0; } if (g.pig === undefined) { g.pig = 0; g.leaf = LEAF_DEFAULT; } return g; }

export function plantGenome(rng) {
  const modules = [];
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i++) modules.push({ t: MODULE.PHOTO, s: rng.range(.3, .6), a: rng.range(-Math.PI, Math.PI) });
  return { modules, brain: new Float32Array(BRAIN_SIZE), diet: rng.range(0, .1), repro: rng.range(.5, .8), invest: rng.range(.25, .45), birth: rng.range(.3, .5),
    freq: rng.range(.05, .5), markers: [rng.next(), rng.next(), rng.next(), rng.next()], sym: 0, elong: ELONG_DEFAULT, seg: 1, form: 0, pig: 0, leaf: LEAF_DEFAULT };
}

// The designed first animal: it turns toward plants, denser algae and (weakly) any
// other edible body, away from threats, and slows down where food is.
// Everything after it is inherited and mutated; nothing else is hand-written.
export function grazerGenome(rng) {
  const modules = [
    { t: MODULE.MOUTH, s: rng.range(.25, .35), a: 0 },
    { t: MODULE.FLAGELLUM, s: rng.range(.4, .6), a: Math.PI },
    { t: MODULE.EYE, s: rng.range(.25, .4), a: 0 }
  ];
  const brain = new Float32Array(BRAIN_SIZE);
  const io = (o, i, w) => { brain[IO + o * NI + i] = w; };
  io(OUT.TURN, IN.PLANT_A, 3); io(OUT.TURN, IN.MEAT_A, 1); io(OUT.TURN, IN.THREAT_A, -3);
  io(OUT.THRUST, IN.THREAT_P, 1.2); io(OUT.THRUST, IN.PLANT_P, -.25); io(OUT.THRUST, IN.TOUCH, -.6);
  io(OUT.TURN, IN.ALGAE_A, 2); io(OUT.THRUST, IN.ALGAE, -.5); io(OUT.BITE, IN.ENERGY, -1.15); io(OUT.TURN, IN.CLOCK, .6);
  brain[BO + OUT.THRUST] = .7; brain[BO + OUT.BITE] = 1; brain[BO + OUT.GLOW] = -1;
  for (let i = 0; i < BO; i++) if (brain[i] === 0 && rng.chance(.25)) brain[i] = rng.normal() * .15;
  return { modules, brain, diet: rng.range(.05, .2), repro: rng.range(.55, .8), invest: rng.range(.3, .45), birth: rng.range(.35, .55),
    freq: rng.range(.05, .5), markers: [rng.next(), rng.next(), rng.next(), rng.next()], sym: 0, elong: ELONG_DEFAULT, seg: 1, form: 0, pig: 0, leaf: LEAF_DEFAULT };
}

// Reflexes for a species designed outside the world (an immigrant): a small hand-written brain per way
// of life, as for the first grazer; everything after arrival is inherited and mutated.
export function brainFor(lifestyle, rng) {
  const brain = new Float32Array(BRAIN_SIZE), io = (o, i, w) => { brain[IO + o * NI + i] = w; };
  if (lifestyle === 'grazer') {
    io(OUT.TURN, IN.PLANT_A, 3); io(OUT.TURN, IN.THREAT_A, -3); io(OUT.THRUST, IN.THREAT_P, 1.2); io(OUT.THRUST, IN.PLANT_P, -.25);
    io(OUT.THRUST, IN.TOUCH, -.6); io(OUT.TURN, IN.ALGAE_A, 2); io(OUT.THRUST, IN.ALGAE, -.5); io(OUT.BITE, IN.ENERGY, -1.15);
    brain[BO + OUT.THRUST] = .7; brain[BO + OUT.BITE] = 1;
  } else if (lifestyle === 'hunter') {
    io(OUT.TURN, IN.MEAT_A, 4); io(OUT.THRUST, IN.MEAT_P, 1.5); io(OUT.TURN, IN.THREAT_A, -2); io(OUT.THRUST, IN.THREAT_P, .8);
    brain[BO + OUT.THRUST] = .45; brain[BO + OUT.BITE] = 1.5;
  } else if (lifestyle === 'ambusher') { // waits, turns towards prey, bites whatever touches it
    io(OUT.TURN, IN.MEAT_A, 3); io(OUT.THRUST, IN.MEAT_P, .6); brain[BO + OUT.THRUST] = -.2; brain[BO + OUT.BITE] = 1.5;
  } else if (lifestyle === 'drifter') { // a slow cruiser that lives on light and nibbles algae
    io(OUT.TURN, IN.ALGAE_A, 1.2); io(OUT.TURN, IN.THREAT_A, -2.5); io(OUT.THRUST, IN.THREAT_P, 1.2); io(OUT.TURN, IN.CLOCK, .8);
    brain[BO + OUT.THRUST] = .3; brain[BO + OUT.BITE] = .4;
  }
  brain[BO + OUT.GLOW] = lifestyle === 'plant' ? 0 : -.5;
  if (lifestyle !== 'plant') for (let i = 0; i < BO; i++) if (brain[i] === 0 && rng.chance(.2)) brain[i] = rng.normal() * .15;
  return brain;
}
export function cloneGenome(g) {
  return { modules: g.modules.map(m => ({ ...m })), brain: Float32Array.from(g.brain), diet: g.diet, repro: g.repro,
    invest: g.invest, birth: g.birth, freq: g.freq, markers: [...g.markers], sym: g.sym, elong: g.elong, seg: g.seg, form: g.form, pig: g.pig, leaf: g.leaf };
}

// Sexual recombination between compatible partners: uniform per gene and per
// brain row, body modules taken position by position.
export function crossover(a, b, rng) {
  const g = cloneGenome(a);
  const n = rng.chance(.5) ? a.modules.length : b.modules.length;
  g.modules = [];
  for (let i = 0; i < n; i++) {
    const src = rng.chance(.5) ? (a.modules[i] || b.modules[i]) : (b.modules[i] || a.modules[i]);
    g.modules.push({ ...src });
  }
  for (let i = 0; i < BRAIN_SIZE; i += NI) if (rng.chance(.5)) g.brain.set(b.brain.subarray(i, Math.min(BRAIN_SIZE, i + NI)), i);
  for (const k of ['diet', 'repro', 'invest', 'birth', 'freq', 'elong', 'pig', 'leaf']) if (rng.chance(.5)) g[k] = b[k];
  for (const k of ['sym', 'seg', 'form']) if (rng.chance(.5)) g[k] = b[k];
  for (let i = 0; i < 4; i++) if (rng.chance(.5)) g.markers[i] = b.markers[i];
  return g;
}

export function mutate(g, rng, rate = 1) {
  const r = p => rng.chance(p * rate);
  const ms = g.modules;
  if (ms.length < MAX_MODULES && r(.035)) {
    // Duplication of an existing module is the commonest structural novelty.
    const src = ms.length && rng.chance(.6) ? ms[rng.int(ms.length)] : { t: rng.int(MODULE_TYPES), s: rng.range(.15, .4), a: rng.range(-Math.PI, Math.PI) };
    ms.splice(rng.int(ms.length + 1), 0, { t: src.t, s: clamp(src.s * rng.range(.7, 1.1), MIN_SIZE, MAX_SIZE), a: rng.range(-Math.PI, Math.PI) });
  }
  if (ms.length > 1 && r(.03)) ms.splice(rng.int(ms.length), 1);
  for (const m of ms) {
    if (r(.12)) m.s = clamp(m.s * Math.exp(rng.normal() * .15), MIN_SIZE, MAX_SIZE);
    if (r(.012)) m.t = rng.int(MODULE_TYPES);
    if (r(.05)) m.a = ((m.a + rng.normal() * .4 + Math.PI) % TAU + TAU) % TAU - Math.PI;
  }
  const b = g.brain;
  for (let i = 0; i < BRAIN_SIZE; i++) {
    if (r(.04)) b[i] = clamp(b[i] + rng.normal() * .35, -6, 6);
    else if (r(.002)) b[i] = 0;
  }
  if (r(.3)) g.diet = clamp(g.diet + rng.normal() * .05, 0, 1);
  if (r(.2)) g.repro = clamp(g.repro + rng.normal() * .05, .25, .98);
  if (r(.2)) g.invest = clamp(g.invest + rng.normal() * .05, .08, .8);
  if (r(.2)) g.birth = clamp(g.birth + rng.normal() * .05, .15, 1);
  if (r(.2)) g.freq = clamp(g.freq * Math.exp(rng.normal() * .2), .02, 2);
  if (r(.15)) g.elong = clamp(g.elong * Math.exp(rng.normal() * .08), ELONG_MIN, ELONG_MAX);
  if (r(P.PLAN_RATE)) g.sym = g.sym === 0 ? 3 + rng.int(6) : rng.chance(.4) ? 0 : clamp(g.sym + (rng.chance(.5) ? 1 : -1), 3, 8); // rare macro-mutation
  if (r(P.SEGMENT_RATE)) g.seg = clamp(g.seg + (g.seg === 1 || rng.chance(.5) ? 1 : -1), 1, SEG_MAX);
  if (r(P.FORM_RATE)) g.form = (g.form + 1 + rng.int(FORMS - 1)) % FORMS;
  if (r(.25)) g.pig = clamp(g.pig + rng.normal() * .08, 0, 1);
  if (r(.25)) g.leaf = clamp(g.leaf + rng.normal() * .08, 0, 1);
  for (let i = 0; i < 4; i++) g.markers[i] = clamp(g.markers[i] + rng.normal() * .025 * rate, 0, 1);
  return g;
}

export function validGenome(g) {
  return g && Array.isArray(g.modules) && g.modules.length >= 1 && g.modules.length <= MAX_MODULES &&
    g.modules.every(m => Number.isInteger(m.t) && m.t >= 0 && m.t < MODULE_TYPES && m.s >= MIN_SIZE && m.s <= MAX_SIZE && Number.isFinite(m.a)) &&
    g.brain instanceof Float32Array && g.brain.length === BRAIN_SIZE && g.brain.every(Number.isFinite) &&
    [g.diet, g.repro, g.invest, g.birth, g.freq].every(Number.isFinite) && g.birth >= .15 && g.birth <= 1 && g.markers.length === 4 && g.markers.every(Number.isFinite) &&
    (g.sym === 0 || (Number.isInteger(g.sym) && g.sym >= 3 && g.sym <= 8)) && g.elong >= ELONG_MIN && g.elong <= ELONG_MAX &&
    Number.isInteger(g.seg) && g.seg >= 1 && g.seg <= SEG_MAX && Number.isInteger(g.form) && g.form >= 0 && g.form < FORMS && g.pig >= 0 && g.pig <= 1 && g.leaf >= 0 && g.leaf <= 1;
}
