// Authoritative ecology of NIMA: Epochs. No wall clock, rendering or visitors
// inside step(): the same checkpoint and code always produce the same history.
import { Rng } from './rng.mjs';
import { P } from './params.mjs';
import { WORLD, GRID, CELL, sun, climate, makeLightColumns, makeLightRows, Seafloor } from './environment.mjs';
import { NI, NH, NO, IH, HH, BH, HO, IO, BO, IN, OUT, phenotype, signature, distance, settleLayout, settlePlan, SIG, FORM, spectral, plantGenome, grazerGenome,
  cloneGenome, crossover, mutate, validGenome } from './genome.mjs';

export const VERSION = 1;
export const HZ = 5, DT = 1 / HZ;
const AREA = (WORLD / 1024) ** 2; // populations scale with the torus area
// Safety limits, separate for sessile and acting bodies, so a crowded plant layer can
// never block animal reproduction. Natural limits (light, nutrients, grazing) keep both below.
export const CAP_SESSILE = Math.round(14000 * AREA), CAP_ACTING = Math.round(3000 * Math.min(AREA, 1)), CAP = CAP_SESSILE + CAP_ACTING; // animals cost CPU: never more than 3000
const TAU = Math.PI * 2;
// Two spatial indexes: coarse buckets for bodies that act, fine buckets for sessile ones.
const BUCKET = 32, NB = WORLD / BUCKET, SB = 16, NS = WORLD / SB;
const FIELD_DT = 2; // environmental fields are integrated every two seconds
const ACT_EVERY = 2, ADT = DT * ACT_EVERY;      // bodies that act are integrated at 2.5 Hz, staggered by id
export { P };
const ln2 = Math.LN2;

const wrap = v => v < 0 ? v + WORLD : v >= WORLD ? v - WORLD : v;
const wrapD = d => d > WORLD / 2 ? d - WORLD : d < -WORLD / 2 ? d + WORLD : d;
const cellOf = (x, y) => (Math.floor(y / CELL) % GRID) * GRID + (Math.floor(x / CELL) % GRID);
const angleTo = (dx, dy, a) => { let r = Math.atan2(dy, dx) - a; r = Math.atan2(Math.sin(r), Math.cos(r)); return r / Math.PI; };

// Recurrent brain, kept small and separate so V8 optimises it well. The summation
// order is fixed: results are bit-identical across runs and restores.
function think(w, h) {
  for (let j = 0; j < NH; j++) {
    let s = w[BH + j];
    const ih = IH + j * NI, hh = HH + j * NH;
    for (let i = 0; i < NI; i++) s += w[ih + i] * xin[i];
    for (let k = 0; k < NH; k++) s += w[hh + k] * h[k];
    hnew[j] = Math.tanh(s);
  }
  h.set(hnew);
  for (let o = 0; o < NO; o++) {
    let s = w[BO + o];
    const ho = HO + o * NH, io = IO + o * NI;
    for (let j = 0; j < NH; j++) s += w[ho + j] * h[j];
    for (let i = 0; i < NI; i++) s += w[io + i] * xin[i];
    yout[o] = Math.tanh(s);
  }
}

// Every creature has the same fields in the same order, so V8 keeps property access monomorphic.
function creature(f) {
  return { id: f.id, x: f.x, y: f.y, a: f.a, vx: f.vx, vy: f.vy, e: f.e, age: f.age, g: f.g, p: f.p, sig: f.sig, scale: f.scale,
    adult: f.adult, sp: f.sp, gen: f.gen, parent: f.parent, born: f.born, h: f.h, hurt: f.hurt, glow: f.glow, inf: f.inf, infT: f.infT,
    immune: f.immune, lastRepro: f.lastRepro, intake: f.intake, kills: f.kills, dead: f.dead, cause: f.cause ?? null, lazarus: f.lazarus ?? 0, flash: f.flash ?? 0,
    mate: null, est: null, adultP: null };
}

// What a species looked like: enough of its genome to draw it again (the museum of forms).
export function portrait(g) {
  const r2 = v => Math.round(v * 100) / 100;
  return { m: g.modules.map(m => [m.t, r2(m.s), r2(m.a)]), sym: g.sym, elong: r2(g.elong), seg: g.seg, form: g.form, pig: r2(g.pig), leaf: r2(g.leaf),
    hue: ((g.markers[0] * .7 + g.markers[1] * .3) % 1 + 1) % 1, acts: phenotype(g).acts };
}

// Scratch buffers shared by every creature (single-threaded, no allocation per step).
const xin = new Float32Array(NI), hnew = new Float32Array(NH), yout = new Float32Array(NO);

export class World {
  constructor({ seed = 731947, plants, grazers, nutrient = P.NUTRIENT } = {}) {
    this.seed = seed >>> 0 || 1; this.rng = new Rng(this.seed);
    this.t = 0; this.tick = 0; this.nextId = 1; this.nextSpecies = 1; this.nextStrain = 1; this.epoch = 1; this.eventSeq = 0; this.fossilSeq = 0; this.layout = 3;
    this.N = new Float64Array(GRID * GRID).fill(nutrient);
    this.D = new Float64Array(GRID * GRID); this.T = new Float32Array(GRID * GRID);
    this.A = new Float64Array(GRID * GRID); // algal carpet: matter per cell
    this.sediment = 2000 * AREA;
    this.climatePhases = [this.rng.range(0, TAU), this.rng.range(0, TAU), this.rng.range(0, TAU)];
    this.creatures = []; this.species = new Map(); this.strains = new Map();
    this.spores = []; this.fossils = []; this.events = []; this.history = [];
    this.counters = { births: 0, deaths: 0, starved: 0, eaten: 0, aged: 0, toxic: 0, impact: 0, capStops: 0, infections: 0, germinated: 0, established: 0 };
    this.meteor = null; this.volcanoes = 0; this.meteors = 0;
    this.animalAbsentSince = null; this.lastEpochAt = 0; this.crash = null;
    this.firsts = {}; this.weather = null;
    this.init();
    // First populations scale with the area of shallow water, the habitable part of the ocean.
    let banks = 0; for (const v of this.shallow) if (v > .3) banks++;
    const habitat = AREA * Math.min(1.5, banks / this.shallow.length / .26);
    plants ??= Math.round(4800 * habitat); grazers ??= Math.round(200 * habitat);
    const founders = new Map();
    const place = (g, kind) => {
      for (let tries = 0; tries < 40; tries++) {
        const x = this.rng.range(0, WORLD), y = this.rng.range(0, WORLD);
        if (this.shallow[cellOf(x, y)] < .3 && tries < 39) continue; // life starts on the banks
        return this.spawn(g, x, y, null, 0);
      }
    };
    for (let i = 0; i < 6; i++) founders.set(`p${i}`, plantGenome(this.rng));
    for (let i = 0; i < 4; i++) founders.set(`g${i}`, grazerGenome(this.rng));
    for (let i = 0; i < plants; i++) {
      const g = mutate(cloneGenome(founders.get(`p${i % 6}`)), this.rng, .3);
      const c = place(g, 'plant'); c.e = c.p.cap * this.rng.range(.5, .8);
    }
    for (let i = 0; i < grazers; i++) {
      const g = mutate(cloneGenome(founders.get(`g${i % 4}`)), this.rng, .3);
      const c = place(g, 'animal'); c.e = c.p.cap * this.rng.range(.4, .7);
    }
    for (const g of founders.values()) this.spores.push({ g: cloneGenome(g), species: 0, at: 0 });
    for (const c of this.creatures) c.age = this.rng.range(0, 2400);
    this.matter0 = this.matter();
    this.event('genesis', { creatures: this.creatures.length, species: this.liveSpecies() });
  }

  init() {
    this.floor = new Seafloor(this.seed);
    this.shallow = new Float32Array(GRID * GRID); this.refreshFloor(Math.floor(this.tick / (HZ * 600)) * 600);
    this.rowsTick = -1; this.photoLoad = new Float32Array(GRID * GRID); this.tallLoad = new Float32Array(GRID * GRID); this.canopyLoad = new Float32Array(GRID * GRID); this.lightCol = new Float32Array(GRID); this.lightRow = new Float32Array(GRID);
    this.scratch = new Float64Array(GRID * GRID);
    this.head = new Int32Array(NB * NB); this.headS = new Int32Array(NS * NS); this.next = new Int32Array(CAP * 2);
    this.environment();
  }

  // ---------- bookkeeping ----------
  // Events and fossils carry sequence numbers so the durable chronicle can be
  // appended exactly once even when a crash replays a stretch of history.
  event(type, data = {}) {
    const e = { seq: ++this.eventSeq, t: this.t, epoch: this.epoch, type, ...data };
    this.events.push(e); if (this.events.length > 2000) this.events.shift();
    return e;
  }
  liveSpecies() { let n = 0; for (const s of this.species.values()) if (s.count > 0) n++; return n; }
  matter() {
    let m = this.sediment;
    for (let i = 0; i < this.N.length; i++) m += this.N[i] + this.D[i] + this.A[i];
    for (const c of this.creatures) if (!c.dead) m += c.p.mass + c.e;
    return m;
  }

  spawn(g, x, y, parent, e, scale = 1) {
    const p = phenotype(g, scale), sig = signature(g);
    const c = creature({ id: this.nextId++, x: wrap(x), y: wrap(y), a: this.rng.range(0, TAU), vx: 0, vy: 0, e, age: 0, g, p, sig, scale, adult: scale >= 1,
      sp: 0, gen: parent ? parent.gen + 1 : 0, parent: parent ? parent.id : 0, born: this.t,
      h: new Float32Array(NH), hurt: 0, glow: 0, inf: 0, infT: 0, immune: [], lastRepro: this.t,
      intake: [0, 0, 0, 0], kills: 0, dead: false });
    this.assignSpecies(c, parent);
    this.creatures.push(c);
    return c;
  }

  assignSpecies(c, parent) {
    let sp = parent ? this.species.get(parent.sp) : null;
    if (sp && distance(c.sig, sp.rep) < P.SPECIES_THRESHOLD) { c.sp = sp.id; sp.count++; return; }
    let best = null, bd = P.SPECIES_THRESHOLD;
    for (const s of this.species.values()) if (s.count > 0) { const d = distance(c.sig, s.rep); if (d < bd) { bd = d; best = s; } }
    if (best) { c.sp = best.id; best.count++; return; }
    const s = { id: this.nextSpecies++, parent: sp ? sp.id : 0, born: this.t, epoch: this.epoch, rep: Float32Array.from(c.sig),
      count: 1, peak: 1, sample: cloneGenome(c.g), established: false, intake: [0, 0, 0, 0], role: null, died: null };
    this.species.set(s.id, s); c.sp = s.id;
  }

  // ---------- environment ----------
  environment() {
    const s = sun(this.t);
    makeLightColumns(this.t, s, this.lightCol);
    // The seasonal belt moves slowly: refreshed every 10 s from a time that depends only on the tick.
    const rowsTick = Math.floor(this.tick / 50) * 50;
    if (this.rowsTick !== rowsTick) { makeLightRows(sun(rowsTick * DT), this.lightRow); this.rowsTick = rowsTick; }
    this.climate = climate(this.t, this.climatePhases);
    let dust = 1;
    if (this.meteor) {
      const since = this.t - this.meteor.at, dark = this.meteor.dark;
      dust = since < dark ? .12 : Math.min(1, .12 + .88 * (since - dark) / 86400);
    }
    this.dust = dust;
    this.globalLight = this.climate * dust * s.yearLight;
    const w = this.weather;
    if (w?.kind === 'storm') this.globalLight *= 1 - .35 * this.weatherStrength(); // churned, murky water
    if (w?.kind === 'warm_current') { // a band of warm, clear water drifts across the ocean
      const k = this.weatherStrength(), bx = this.currentX(), half = 80;
      for (let gx = 0; gx < GRID; gx++) { const d = Math.abs(wrapD((gx + .5) * CELL - bx)); if (d < half * 1.5) this.lightCol[gx] *= 1 + .35 * k * Math.exp(-(d * d) / (half * half)); }
    }
  }
  refreshFloor(t) {
    this.floor.fill(t, this.shallow);
    const deep = [], slope = []; for (let p = 0; p < this.shallow.length; p++) { const s = this.shallow[p]; if (s < .2) deep.push(p); if (s >= .05 && s < .6) slope.push(p); }
    this.deep = Int32Array.from(deep); this.slope = Int32Array.from(slope.length ? slope : deep); // the lit margins of the banks
  }
  light(cell) {
    const gx = cell % GRID, gy = (cell - gx) / GRID;
    return this.lightCol[gx] * this.lightRow[gy] * this.globalLight * (.3 + .7 * this.shallow[cell]);
  }

  fields(dt) {
    const N = this.N, D = this.D, T = this.T, S = this.scratch, n = GRID;
    // Nutrients diffuse: symmetric fluxes conserve matter exactly up to rounding.
    S.set(N);
    const k = .03 * dt;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const p = y * n + x, r = y * n + (x + 1) % n, d = ((y + 1) % n) * n + x;
      let f = k * (N[p] - N[r]); S[p] -= f; S[r] += f;
      f = k * (N[p] - N[d]); S[p] -= f; S[d] += f;
    }
    N.set(S);
    // Detritus decays to nutrients; in deep water part of it sinks to the sediment. Upwelling, as
    // along real coasts, brings the sediment and some deep water up the slopes of the banks,
    // where there is light to use it.
    const decay = 1 - Math.exp(-dt / 1800), sink = dt / 7200, deep = this.deep, fade = Math.exp(-ln2 * dt / 7200);
    let sunk = 0;
    for (let p = 0; p < N.length; p++) {
      if (D[p] > 0) { const d = D[p] * decay; D[p] -= d; N[p] += d; }
      if (T[p] > 0) { T[p] *= fade; if (T[p] < .01) T[p] = 0; }
    }
    for (const p of deep) { const s = D[p] * sink; D[p] -= s; sunk += s; }
    // Algal carpet: logistic growth limited by light under the plant canopy and by
    // nutrients; a thin film is everywhere, so bare water greens again on its own.
    const A = this.A, L = this.photoLoad, amax = P.ALGAE_MAX, r = P.ALGAE_R * dt, die = P.ALGAE_DEATH * dt, film = P.ALGAE_SEED, ls = P.LIGHT_SHARE, kn = P.KN;
    const col = this.lightCol, row = this.lightRow, gl = this.globalLight, sh = this.shallow;
    for (let p = 0; p < A.length; p++) {
      const a = A[p], shade = L[p] >= ls ? 0 : 1 - L[p] / ls;
      let g = 0;
      if (shade > 0 && a < amax) {
        const nut = N[p], gx = p % n, light = col[gx] * row[(p - gx) / n] * gl * (.3 + .7 * sh[p]); // as this.light(p)
        g = r * light * shade * (a < film ? film : a) * (1 - a / amax) * nut / (nut + kn);
        if (g > nut * .5) g = nut * .5;
      }
      const d = a * die;
      A[p] = a + g - d; N[p] -= g; D[p] += d;
    }
    this.sediment += sunk;
    const slope = this.slope;
    if (slope.length) {
      const stir = this.weather?.kind === 'storm' ? 1 + 3 * this.weatherStrength() : 1; // a storm churns the water: more comes up
      let up = this.sediment * dt * stir / P.UPWELL_SEDIMENT; this.sediment -= up;
      if (deep.length) { const f = dt * stir / P.UPWELL_WATER; for (const p of deep) { const w = N[p] * f; N[p] -= w; up += w; } }
      const each = up / slope.length;
      for (const p of slope) N[p] += each;
    }
  }

  spend(c, amount, cell) { // energy leaves the body as dissolved nutrients
    const a = amount < c.e ? amount : c.e > 0 ? c.e : 0;
    c.e -= a; this.N[cell] += a; return a;
  }

  buildBuckets() {
    const head = this.head, headS = this.headS, cs = this.creatures;
    head.fill(-1); headS.fill(-1);
    if (this.next.length < cs.length) this.next = new Int32Array(cs.length * 2);
    const next = this.next;
    let acting = 0;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]; if (c.p.acts) acting++;
      if (c.p.acts) { const b = (Math.floor(c.y / BUCKET) % NB) * NB + (Math.floor(c.x / BUCKET) % NB); next[i] = head[b]; head[b] = i; }
      else { const b = (Math.floor(c.y / SB) % NS) * NS + (Math.floor(c.x / SB) % NS); next[i] = headS[b]; headS[b] = i; }
    }
    this.nActing = acting; this.nSessile = cs.length - acting;
  }
  scan(head, size, n, x, y, r, fn) {
    const span = Math.ceil(r / size), bx = Math.floor(x / size), by = Math.floor(y / size), r2 = r * r, cs = this.creatures, next = this.next;
    for (let j = -span; j <= span; j++) for (let i = -span; i <= span; i++) {
      const b = (((by + j) % n + n) % n) * n + ((bx + i) % n + n) % n;
      for (let k = head[b]; k !== -1; k = next[k]) {
        const o = cs[k]; if (o.dead) continue;
        const dx = wrapD(o.x - x), dy = wrapD(o.y - y), d2 = dx * dx + dy * dy;
        if (d2 <= r2) fn(o, dx, dy, d2);
      }
    }
  }
  // Visit every creature within radius r of (x, y). Callback gets (creature, dx, dy, d2).
  near(x, y, r, fn) { this.scan(this.head, BUCKET, NB, x, y, r, fn); this.scan(this.headS, SB, NS, x, y, r, fn); }
  // Nearest accepted sessile body within R, searched ring by ring outward from (x, y).
  // Nearest sessile body within R that eater c can bite, searched ring by ring outward.
  nearestEdibleSessile(c, R) {
    const x = c.x, y = c.y, bite = c.p.jaw, maxMass = c.p.mass * 3, sp = c.sp, floor = P.CROP_FLOOR + .05, root = P.ROOT_SCALE + .1;
    const bx = Math.floor(x / SB), by = Math.floor(y / SB), maxK = Math.floor(R / SB) + 1, cs = this.creatures, next = this.next, head = this.headS; // ring k is at least (k-1)·SB away
    let best = null, bd = R * R, bdx = 0, bdy = 0;
    for (let k = 0; k <= maxK; k++) {
      if (best && k > 1 && bd < ((k - 1) * SB) ** 2) break; // nothing in ring k can be closer
      for (let j = -k; j <= k; j++) {
        const edge = j === -k || j === k;
        for (let i = -k; i <= k; i += edge ? 1 : 2 * k) {
          const b = (((by + j) % NS + NS) % NS) * NS + ((bx + i) % NS + NS) % NS;
          for (let q = head[b]; q !== -1; q = next[q]) {
            const o = cs[q]; if (o.dead) continue;
            const dx = wrapD(o.x - x), dy = wrapD(o.y - y), d2 = dx * dx + dy * dy;
            if (d2 < bd && o.sp !== sp) {
              const op = o.p;
              if (bite > op.defense && op.mass < maxMass && (op.plantFrac < .5 || o.scale > root || o.e > floor * op.cap)) { bd = d2; best = o; bdx = dx; bdy = dy; }
            }
          }
          if (k === 0) break;
        }
      }
    }
    this.found = best; this.foundDx = bdx; this.foundDy = bdy; this.foundD2 = bd;
    return best;
  }
  edible(c, o) {
    return c.p.jaw > o.p.defense && o.p.mass < c.p.mass * 3 &&
      (o.p.plantFrac < .5 || o.scale > P.ROOT_SCALE + .1 || o.e > (P.CROP_FLOOR + .05) * o.p.cap);
  }

  // ---------- one step ----------
  step() {
    this.environment();
    if (this.tick % (HZ * FIELD_DT) === 0) this.fields(FIELD_DT);
    if (this.tick % (HZ * 600) === 0) this.refreshFloor(this.t);
    this.buildBuckets();
    const cs = this.creatures, N = this.N, D = this.D, T = this.T, L = this.photoLoad, H = this.tallLoad, K = this.canopyLoad, LS = P.LIGHT_SHARE;
    if (this.tick % HZ === 0) { // shading map, once per second: producers barely move
      L.fill(0); H.fill(0); K.fill(0);
      for (const c of cs) if (c.p.photo > 0) {
        const span = c.p.form === FORM.FILAMENT ? 1 : c.p.form === FORM.RUNNER ? 2 : 0;
        if (span) { // a filament lies across three cells along its axis, a runner across five
          const k = c.p.photo / (2 * span + 1), dx = Math.cos(c.a) * CELL, dy = Math.sin(c.a) * CELL;
          for (let i = -span; i <= span; i++) L[cellOf(wrap(c.x + dx * i), wrap(c.y + dy * i))] += k;
        } else {
          const cell = cellOf(c.x, c.y); L[cell] += c.p.photo;
          if (c.p.form === FORM.BUSH) H[cell] += c.p.photo; else if (c.p.form === FORM.KELP) K[cell] += c.p.photo;
        }
      }
    }
    const born = [];
    for (const c of cs) {
      if (c.dead) continue;
      const p = c.p;
      // Sessile bodies are integrated once per second and acting bodies at 2.5 Hz, staggered by id.
      if (p.acts ? (c.id + this.tick) % ACT_EVERY !== 0 : (c.id + this.tick) % HZ !== 0) continue;
      const dt = p.acts ? ADT : DT * HZ, cell = cellOf(c.x, c.y);
      c.age += dt; c.hurt *= p.acts ? .64 : .33;
      this.spend(c, p.upkeep * dt, cell);
      if (!p.acts && (p.form === FORM.KELP || p.form === FORM.BUSH) && this.weather?.kind === 'storm') this.spend(c, p.upkeep * 2 * this.weatherStrength() * dt, cell); // tall plants are torn by the storm
      if (p.photo > 0) {
        // Light is shared in a crowded cell, in layers: kelp fronds stand above everything and are
        // shaded only by kelp, bushes by kelp and bushes, the rest by all; a filament or a runner
        // takes its share from each of its cells. A floating colony lives near the surface and kelp
        // fronds reach up to it, so they see brighter light even over deeper water.
        let share, nut = N[cell], depth = this.shallow[cell], lit = this.light(cell);
        if (p.form === FORM.KELP) share = K[cell] > LS ? LS / K[cell] : 1;
        else if (p.form === FORM.BUSH) { const l = H[cell] + K[cell]; share = l > LS ? LS / l : 1; }
        else if (p.form === FORM.FILAMENT || p.form === FORM.RUNNER) {
          const span = p.form === FORM.RUNNER ? 2 : 1, dx = Math.cos(c.a) * CELL, dy = Math.sin(c.a) * CELL; share = 0;
          for (let i = -span; i <= span; i++) { const l = L[cellOf(wrap(c.x + dx * i), wrap(c.y + dy * i))]; share += (l > LS ? LS / l : 1) / (2 * span + 1); }
        } else share = L[cell] > LS ? LS / L[cell] : 1;
        const reach = p.form === FORM.COLONY ? P.FLOAT_DEPTH : p.form === FORM.KELP && depth >= .1 ? P.KELP_DEPTH : 0; // floating, or fronds up to the surface from a slope (kelp holds to the bottom: not over the deep)
        if (depth < reach) { lit *= (.3 + .7 * reach) / (.3 + .7 * depth); depth = reach; }
        // A swimming body has less surface for its bulk: the bigger it is, the less light each of
        // its chloroplasts gets (plants spread theirs in leaves).
        const bulk = p.acts ? Math.min(1.2, Math.sqrt(P.MOTILE_LIGHT_MASS / p.mass)) : 1;
        let prod = p.photo * lit * bulk * spectral(p.pig, depth) * p.leafLight * share * P.PMAX * nut / (nut + P.KN) * dt;
        if (prod > nut * .5) prod = nut * .5;
        N[cell] -= prod; c.e += prod; c.intake[0] += prod;
      }
      if (T[cell] > .05) {
        const before = c.e; this.spend(c, T[cell] * .06 * p.mass * dt, cell);
        if (c.e <= 0 && before > 0) c.cause = 'toxic';
      }
      if (c.inf) this.disease(c, cell, dt);
      if (p.acts) this.behave(c, cell, dt);
      if (c.dead) continue;
      if (c.e > p.cap) { N[cell] += c.e - p.cap; c.e = p.cap; }
      if (c.scale < 1 && (c.id + this.tick) % (HZ * 5) < (p.acts ? ACT_EVERY : HZ) && c.e > P.GROW_RESERVE * p.cap) this.grow(c, cell); // every 5 s
      const lifespan = 1800 + 2400 * Math.sqrt(.25 + (p.mass - .25) / c.scale); // set by adult size
      if (c.e <= 0 || c.age > lifespan) { this.die(c, c.e <= 0 ? (c.cause || 'starved') : 'aged', cell); continue; }
      if (c.adult && c.scale >= .5 && c.age > P.MATURITY_BASE + P.MATURITY_MASS * p.mass && this.t - c.lastRepro > 10 && c.e >= c.g.repro * p.cap) this.reproduce(c, cell, born);
    }
    this.creatures = cs.filter(c => !c.dead);
    for (const c of born) this.creatures.push(c);
    this.tick++; this.t = this.tick * DT;
    if (this.tick % HZ === 0) this.chance();
    if (this.tick % (HZ * 60) === 0) this.minute();
  }

  behave(c, cell, dt) {
    const p = c.p, R = p.range;
    let plant = null, pd = Infinity, meat = null, md = Infinity, threat = null, td = Infinity, kin = null, kd = Infinity;
    let glowA = 0, glowP = 0, contact = null, cd = Infinity;
    let pdx = 0, pdy = 0, mdx = 0, mdy = 0, tdx = 0, tdy = 0, kdx = 0, kdy = 0;
    // Inline neighbour loop (same order as scan()): a closure here keeps V8 from optimising.
    const span = Math.ceil(R / BUCKET), bx = Math.floor(c.x / BUCKET), by = Math.floor(c.y / BUCKET), R2 = R * R;
    const cs = this.creatures, next = this.next, head = this.head;
    for (let j = -span; j <= span; j++) for (let i = -span; i <= span; i++) {
     const b = (((by + j) % NB + NB) % NB) * NB + ((bx + i) % NB + NB) % NB;
     for (let k = head[b]; k !== -1; k = next[k]) {
      const o = cs[k]; if (o.dead || o === c) continue;
      const dx = wrapD(o.x - c.x), dy = wrapD(o.y - c.y), d2 = dx * dx + dy * dy;
      if (d2 > R2) continue;
      const same = o.sp === c.sp;
      if (same) { if (d2 < kd) { kd = d2; kin = o; kdx = dx; kdy = dy; } }
      else {
        if (this.edible(c, o)) {
          if (o.p.plantFrac >= .5) { if (d2 < pd) { pd = d2; plant = o; pdx = dx; pdy = dy; } }
          else if (d2 < md) { md = d2; meat = o; mdx = dx; mdy = dy; }
          const reach = p.radius + o.p.radius + 1 + p.reach; // tentacles reach farther
          if (d2 < reach * reach && d2 < cd) { cd = d2; contact = o; }
        }
        if (o.p.jaw > p.defense && o.p.jaw > p.jaw && d2 < td) { td = d2; threat = o; tdx = dx; tdy = dy; }
      }
      if (o.glow > 0) {
        const v = o.glow * o.p.glow * (1 - Math.sqrt(d2) / R);
        if (v > glowP) { glowP = v; glowA = angleTo(dx, dy, c.a); }
      }
     }
    }
    if (p.bite > 0 && this.nearestEdibleSessile(c, R)) {
      const o = this.found, d2 = this.foundD2;
      if (o.p.plantFrac >= .5) { if (d2 < pd) { pd = d2; plant = o; pdx = this.foundDx; pdy = this.foundDy; } }
      else if (d2 < md) { md = d2; meat = o; mdx = this.foundDx; mdy = this.foundDy; }
      const reach = p.radius + o.p.radius + 1 + p.reach;
      if (d2 < reach * reach && d2 < cd) { cd = d2; contact = o; }
    }
    xin.fill(0);
    if (plant) { xin[IN.PLANT_A] = angleTo(pdx, pdy, c.a); xin[IN.PLANT_P] = 1 - Math.sqrt(pd) / R; }
    if (meat) { xin[IN.MEAT_A] = angleTo(mdx, mdy, c.a); xin[IN.MEAT_P] = 1 - Math.sqrt(md) / R; }
    if (threat) { xin[IN.THREAT_A] = angleTo(tdx, tdy, c.a); xin[IN.THREAT_P] = 1 - Math.sqrt(td) / R; }
    if (kin) { xin[IN.KIN_A] = angleTo(kdx, kdy, c.a); xin[IN.KIN_P] = 1 - Math.sqrt(kd) / R; }
    xin[IN.GLOW_A] = glowA; xin[IN.GLOW_P] = Math.min(1, glowP);
    xin[IN.LIGHT] = this.light(cell); xin[IN.ENERGY] = c.e / p.cap; xin[IN.HURT] = c.hurt;
    xin[IN.CLOCK] = Math.sin(TAU * c.g.freq * c.age);
    xin[IN.TOUCH] = contact ? 1 : 0;
    if (p.bite > 0) { // taste of the water here, and the direction where the carpet is thickest
      const A = this.A, here = A[cell];
      let best = here * 1.1, bestA = 0;
      for (let k = 0; k < 6; k++) {
        const a = c.a + (k - 2.5) * .7, v = A[cellOf(wrap(c.x + Math.cos(a) * 10), wrap(c.y + Math.sin(a) * 10))];
        if (v > best) { best = v; bestA = (k - 2.5) * .7 / Math.PI; }
      }
      xin[IN.ALGAE] = here / P.ALGAE_MAX; xin[IN.ALGAE_A] = bestA;
    }
    c.mate = kin && kd < 900 ? kin : null;
    think(c.g.brain, c.h);
    // Motion: flagella give thrust and steering; mass resists both, the body's shape sets
    // how much the water holds it back and how fast it turns.
    if (p.thrust > 0) {
      const f = yout[OUT.THRUST] > 0 ? yout[OUT.THRUST] : .3 * yout[OUT.THRUST];
      c.a += yout[OUT.TURN] * 2.5 * dt * Math.min(1, p.thrust * 3) * p.turn;
      if (c.a > Math.PI) c.a -= TAU; else if (c.a < -Math.PI) c.a += TAU;
      const acc = f * p.push * 20 / p.mass;
      const drag = Math.exp(-1.5 * p.drag * dt);
      c.vx = (c.vx + Math.cos(c.a) * acc * dt) * drag; c.vy = (c.vy + Math.sin(c.a) * acc * dt) * drag;
      if (this.weather?.kind === 'storm') { const k = this.weatherStrength() * 1.2 / Math.sqrt(p.mass); c.vx += Math.cos(this.weather.dir) * k * dt; c.vy += Math.sin(this.weather.dir) * k * dt; } // the surge carries swimmers
      c.x = wrap(c.x + c.vx * dt); c.y = wrap(c.y + c.vy * dt);
      this.spend(c, P.MOTION_COST * p.thrust * p.stroke * Math.abs(f) * dt, cell);
    }
    if (this.trace) this.trace(c, xin, yout, contact);
    const want = p.glow > 0 && yout[OUT.GLOW] > 0 ? yout[OUT.GLOW] : 0; // the brain's own light
    if (want) this.spend(c, P.GLOW_COST * p.glow * want * dt, cell);
    c.glow = c.flash > want ? c.flash : want; // a startle flash outshines it for a moment
    if (c.flash) { c.flash *= .45; if (c.flash < .05) c.flash = 0; }
    if (p.bite > 0 && yout[OUT.BITE] > 0) {
      if (contact && !contact.dead) { this.bite(c, contact, cell, dt); c.vx *= .3; c.vy *= .3; } // a feeding body holds on
      else if (this.A[cell] > .01) { // grazing the algal carpet while swimming
        const a = this.A[cell], take = Math.min(a, p.jaw * P.ALGAE_RATE * dt * a / (a + .2));
        const gain = take * (P.BASE_EFF + P.PLANT_EFF * (1 - c.g.diet));
        this.A[cell] -= take; c.e += gain; this.D[cell] += take - gain; c.intake[1] += gain;
        this.spend(c, .002 * p.bite * dt, cell);
      } else if (this.D[cell] > .001) {
        const d = this.D[cell], take = Math.min(d, p.jaw * P.DETRITUS_RATE * dt * d / (d + .3)), gain = take * .35;
        this.D[cell] -= take; c.e += gain; this.N[cell] += take - gain; c.intake[3] += gain;
        this.spend(c, .002 * p.bite * dt, cell);
      }
    }
  }

  bite(c, o, cell, dt = ADT) {
    let take = c.p.jaw * P.BITE_RATE * dt * o.p.grazed, killed = false; // broad leaves give more to a grazer
    if (o.p.plantFrac >= .5) {
      // Grazing eats stored energy, then tissue; the base of the body survives and regrows.
      const avail = Math.max(0, o.e - P.CROP_FLOOR * o.p.cap);
      let fromBody = 0;
      if (take > avail) {
        const adult = o.adultP || (o.adultP = phenotype(o.g)), want = take - avail;
        const minMass = .25 + (adult.mass - .25) * P.ROOT_SCALE;
        fromBody = Math.min(want, Math.max(0, o.p.mass - minMass));
        if (fromBody > 0) {
          const scale = Math.max(P.ROOT_SCALE, o.scale - fromBody / (adult.mass - .25));
          const np = phenotype(o.g, scale); fromBody = o.p.mass - np.mass;
          o.scale = scale; o.p = np;
        }
        take = avail + fromBody;
      }
      if (take <= 0) return;
      o.e -= take - fromBody;
      if (o.e > o.p.cap) { this.N[cell] += o.e - o.p.cap; o.e = o.p.cap; }
    } else {
      // A bitten animal with light organs flashes by reflex, like many deep-sea shrimps and
      // jellies: the startled attacker may let go, and the prey darts away.
      if (o.p.glow > 0) {
        this.spend(o, P.FLASH_COST * o.p.glow, cellOf(o.x, o.y)); o.flash = 1;
        if (this.rng.chance(Math.min(P.FLASH_ESCAPE_MAX, P.FLASH_ESCAPE * o.p.glow))) {
          const a = Math.atan2(wrapD(o.y - c.y), wrapD(o.x - c.x)); o.vx += Math.cos(a) * 3; o.vy += Math.sin(a) * 3; o.hurt = 1;
          this.counters.escapes = (this.counters.escapes || 0) + 1; return;
        }
      }
      // Attacking an animal: a stronger bite, and the prey is held while it struggles.
      take = c.p.jaw * P.ATTACK_RATE * dt;
      const hold = .5 / (1 + c.p.tent); o.vx *= hold; o.vy *= hold;     // tentacles hold the prey harder
      if (take >= o.e) { take = Math.max(0, o.e) + o.p.mass; killed = true; }
      o.e -= take;
    }
    o.hurt = 1;
    const pf = o.p.plantFrac, d = c.g.diet;
    const ePlant = P.BASE_EFF + P.PLANT_EFF * (1 - d), eMeat = P.MEAT_BASE + P.MEAT_EFF * d;
    const gainPlant = take * pf * ePlant, gainMeat = take * (1 - pf) * eMeat, gain = gainPlant + gainMeat;
    c.e += gain; c.intake[1] += gainPlant; c.intake[2] += gainMeat;
    this.D[cell] += take - gain; // spilled and undigested matter
    this.spend(c, .003 * c.p.bite * dt, cell);
    if (o.p.spine > 0) { // spines sting whoever bites: the cost grows with the bite
      this.spend(c, P.SPINE_HARM * take * o.p.spine / (o.p.spine + .5), cell); c.hurt = 1;
      if (c.e <= 0) c.cause = 'stung';
    }
    if (killed) { o.e = 0; o.dead = true; o.cause = 'eaten'; c.kills++; this.died(o, 'eaten'); }
  }

  disease(c, cell, dt) {
    const s = this.strains.get(c.inf);
    if (!s) { c.inf = 0; return; }
    this.spend(c, s.virulence * c.p.mass * dt, cell);
    if (c.e <= 0) c.cause = 'disease';
    c.infT -= dt;
    // Contact transmission only between bodies similar to the strain's original host.
    this.near(c.x, c.y, c.p.radius + 4, (o, dx, dy, d2) => {
      if (o === c || o.inf || o.immune.includes(s.id)) return;
      const reach = c.p.radius + o.p.radius + 2;
      if (d2 < reach * reach && distance(o.sig, s.sig) < s.radius && this.rng.chance(s.beta * dt)) {
        o.inf = s.id; o.infT = s.duration; s.infected++; s.total++; this.counters.infections++;
        if (s.total === 25) this.event('epidemic', { strain: s.id, species: s.host });
      }
    });
    if (c.infT <= 0) { c.inf = 0; c.immune.push(s.id); if (c.immune.length > 4) c.immune.shift(); s.infected--; }
  }

  // Juveniles grow in steps of 10% of adult size, paying for new tissue from their reserve.
  grow(c, cell) {
    const next = Math.min(1, c.scale + .1), np = phenotype(c.g, next), dm = np.mass - c.p.mass, cost = dm * 1.25;
    if (c.e - cost < P.GROW_RESERVE * np.cap) return;
    c.e -= cost; this.N[cell] += cost - dm; c.scale = next; c.p = np;
    if (next >= 1) c.adult = true;
  }

  reproduce(c, cell, born) {
    if (c.p.acts ? this.nActing >= CAP_ACTING : this.nSessile >= CAP_SESSILE) { this.counters.capStops++; return; }
    // Affordability is judged on the parent's own plan before any partner search or genome copy.
    const est = c.est || (c.est = phenotype(c.g, c.g.birth)); // pure function of the genome, cached
    if (c.e < est.mass * 1.25 * 1.1 + Math.min(c.g.invest * c.e, est.cap) + P.RESERVE * c.p.cap) return;
    let mate = c.mate && !c.mate.dead ? c.mate : null;
    if (!c.p.acts) { // sessile bodies release gametes to near relatives
      let md = 900;
      this.near(c.x, c.y, 30, (o, dx, dy, d2) => { if (o !== c && o.sp === c.sp && d2 < md) { md = d2; mate = o; } });
    }
    if (mate && distance(mate.sig, c.sig) > P.SPECIES_THRESHOLD) mate = null;
    const g = mutate(mate ? crossover(c.g, mate.g, this.rng) : cloneGenome(c.g), this.rng);
    const scale = c.g.birth, cp = phenotype(g, scale), ce = Math.min(c.g.invest * c.e, cp.cap);
    // A runner's offshoot is cheap for the parent: part of it is built from nutrients in the water.
    const fromWater = c.p.form === FORM.RUNNER ? Math.min(this.N[cell] * .5, cp.mass * 1.25 * (1 - P.RUNNER_CLONE)) : 0, build = cp.mass * 1.25 - fromWater;
    if (c.e < build + ce + P.RESERVE * c.p.cap) return;
    c.e -= build + ce; this.N[cell] += build - cp.mass; c.lastRepro = this.t;
    let x, y;
    if (cp.thrust > 0) { x = c.x - Math.cos(c.a) * (c.p.radius + 2); y = c.y - Math.sin(c.a) * (c.p.radius + 2); }
    else if (c.p.form === FORM.RUNNER) { // a runner sends its young out along the stolon
      const a = c.a + (this.rng.chance(.5) ? 0 : Math.PI) + this.rng.range(-.3, .3), r = this.rng.range(10, 22); x = c.x + Math.cos(a) * r; y = c.y + Math.sin(a) * r;
    } else { const a = this.rng.range(0, TAU), r = this.rng.range(4, 24); x = c.x + Math.cos(a) * r; y = c.y + Math.sin(a) * r; }
    const pre = this.creatures.length;
    const child = this.spawn(g, x, y, c, ce, scale);
    this.creatures.length = pre; // spawn() appends; newborns join after the sweep
    born.push(child); this.counters.births++;
    if (child.p.acts) this.nActing++; else this.nSessile++;
  }

  die(c, cause, cell) {
    c.dead = true; this.D[cell] += c.p.mass + Math.max(0, c.e); c.e = 0;
    this.died(c, cause);
  }
  died(c, cause) {
    this.counters.deaths++; this.counters[cause] = (this.counters[cause] || 0) + 1;
    if (c.inf) { const s = this.strains.get(c.inf); if (s) s.infected--; c.inf = 0; }
    const s = this.species.get(c.sp);
    if (s) {
      s.count--; for (let i = 0; i < 4; i++) s.intake[i] += c.intake[i];
      if (s.count === 0) this.extinct(s);
    }
  }
  extinct(s) {
    s.died = this.t;
    if (s.established) {
      this.fossils.push({ seq: ++this.fossilSeq, ...this.fossil(s) }); if (this.fossils.length > 500) this.fossils.shift();
      this.spores.push({ g: cloneGenome(s.sample), species: s.id, at: this.t });
      if (this.spores.length > 300) this.spores.splice(this.rng.int(this.spores.length - 50), 1);
      this.event('extinction', { species: s.id, role: s.role, peak: s.peak, lived: Math.round(this.t - s.born) });
    } else this.species.delete(s.id);
  }
  fossil(s) {
    const p = phenotype(s.sample);
    return { id: s.id, parent: s.parent, born: s.born, died: s.died, epoch: s.epoch, peak: s.peak, role: s.role,
      body: { mass: p.mass, photo: p.photo, bite: p.bite, thrust: p.thrust, armor: p.armor, eye: p.eye, glow: p.glow, fat: p.fat, modules: s.sample.modules.length },
      diet: s.sample.diet, modules: s.sample.modules.map(m => m.t), lazarus: s.lazarus || null, immigrant: s.immigrant || null, sym: s.sample.sym, elong: +s.sample.elong.toFixed(2), seg: s.sample.seg, form: p.acts ? 0 : s.sample.form, pig: +s.sample.pig.toFixed(2), leaf: +s.sample.leaf.toFixed(2),
      hue: ((s.sample.markers[0] * .7 + s.sample.markers[1] * .3) % 1 + 1) % 1, portrait: portrait(s.sample) };
  }

  // ---------- rare processes, once per simulated second ----------
  chance() {
    const r = this.rng;
    if (this.meteor && this.t - this.meteor.at >= this.meteor.dark + 86400) {
      this.meteor = null; this.event('meteor_clear'); this.germinate(3, 'after_meteor');
    }
    this.weatherTick(r);
    if (this.creatures.length && r.chance(1 / P.STRAIN_MEAN)) {
      const host = this.creatures[r.int(this.creatures.length)];
      if (!host.inf) {
        const s = { id: this.nextStrain++, sig: Float32Array.from(host.sig), radius: .22, beta: .35, virulence: .01, duration: 240,
          born: this.t, host: host.sp, infected: 1, total: 1 };
        this.strains.set(s.id, s); host.inf = s.id; host.infT = s.duration;
      }
    }
    for (const [id, s] of this.strains) if (s.infected <= 0) {
      this.strains.delete(id);
      if (s.total >= 25) this.event('epidemic_end', { strain: id, species: s.host, infected: s.total });
    }
    const stagnant = this.stagnant();
    if (!this.meteor && r.chance(1 / P.METEOR_MEAN * (stagnant ? 4 : 1))) this.impact();
    if (r.chance(1 / P.VOLCANO_MEAN)) this.eruption();
  }
  // ---------- weather: middle-sized events, about one a day, never two at once ----------
  weatherTick(r) {
    const w = this.weather;
    if (w) {
      if (w.kind === 'red_tide' && this.t < w.at + (w.until - w.at) * .6) this.toxic(w.x, w.y, w.r, .55 * Math.min(1, (this.t - w.at) / 3600)); // the bloom thickens, then fades
      if (w.kind === 'bloom' && this.t < w.at + 3600) this.feed(w.x, w.y, w.r, this.sediment * .03 / 3600);           // nutrients well up for an hour
      if (this.t >= w.until) { this.event(w.kind + '_end', { hours: Math.round((w.until - w.at) / 3600) }); this.weather = null; }
      return;
    }
    if (r.chance(1 / P.STORM_MEAN)) this.startWeather('storm');
    else if (r.chance(1 / P.RED_TIDE_MEAN)) this.startWeather('red_tide');
    else if (r.chance(1 / P.CURRENT_MEAN)) this.startWeather('warm_current');
    else if (r.chance(1 / P.BLOOM_MEAN)) this.startWeather('bloom');
  }
  startWeather(kind, by = undefined) { // by: who called it, if not chance (the demiurge)
    if (this.weather) return false;
    const r = this.rng, coast = () => { const p = this.slope[r.int(this.slope.length)]; return { x: (p % GRID + .5) * CELL, y: (Math.floor(p / GRID) + .5) * CELL }; };
    const start = (hours, extra = {}) => { this.weather = { kind, at: this.t, until: this.t + hours * 3600, ...extra }; this.event(kind, { hours: Math.round(hours), by, ...extra }); };
    if (kind === 'storm') start(r.range(2, 4), { dir: r.range(0, TAU) });
    else if (kind === 'red_tide') { const c = coast(); start(r.range(4, 6), { x: c.x, y: c.y, r: r.range(60, 110) }); }
    else if (kind === 'warm_current') start(r.range(16, 24), { x0: r.range(0, WORLD) });
    else if (kind === 'bloom') { const c = coast(); start(6, { x: c.x, y: c.y, r: r.range(70, 120) }); }
    else return false;
    return true;
  }
  // Immigrants: a species designed outside the world (by the AI demiurge) is carried in by a current to
  // one place, a small founding group with a little variation. Their matter comes from the sediment, so
  // nothing is created; from then on only selection decides their fate.
  immigrate(g, count, region, origin = {}) {
    const r = this.rng, cells = region === 'deep' ? this.deep : region === 'slopes' ? this.slope : null;
    let cx, cy;
    for (let tries = 0; tries < 60; tries++) {
      const p = cells ? cells[r.int(cells.length)] : r.int(GRID * GRID);
      if (!cells && this.shallow[p] < .7) continue; // the shallows: the bright middle of a bank
      if (this.T[p] > .05) continue;
      cx = (p % GRID + .5) * CELL; cy = (Math.floor(p / GRID) + .5) * CELL; break;
    }
    if (cx === undefined) return null;
    let founder = null, made = 0;
    for (let i = 0; i < count; i++) {
      const gi = i ? mutate(cloneGenome(g), r, .3) : cloneGenome(g), p = phenotype(gi), e = p.cap * .5, need = p.mass + e;
      if (this.sediment < need * 3) break;
      this.sediment -= need;
      const a = r.range(0, TAU), d = r.range(0, 22);
      const c = this.spawn(gi, cx + Math.cos(a) * d, cy + Math.sin(a) * d, founder, e);
      if (!founder) { founder = c; const s = this.species.get(c.sp); if (s && s.born === this.t) s.immigrant = { at: this.t, ...origin }; }
      made++;
    }
    if (!founder) return null;
    this.event('immigration', { species: founder.sp, count: made, region, x: cx / WORLD, y: cy / WORLD });
    return { species: founder.sp, made };
  }
  // 0 → 1 → 0 over the event: half an hour to build up, half an hour to calm down.
  weatherStrength() { const w = this.weather; if (!w) return 0; return Math.max(0, Math.min(1, (this.t - w.at) / 1800, (w.until - this.t) / 1800)); }
  currentX() { const w = this.weather; return wrap(w.x0 + (this.t - w.at) / (w.until - w.at) * WORLD); } // crosses the whole ocean once
  // Sediment welling up around a point, spread as a soft disc (matter only moves).
  feed(x, y, r, amount) {
    const n = Math.ceil(r / CELL), cells = [];
    let wsum = 0;
    for (let gy = -n; gy <= n; gy++) for (let gx = -n; gx <= n; gx++) { const d = Math.hypot(gx, gy) * CELL; if (d > r) continue; const wgt = 1 - d / r; cells.push([cellOf(wrap(x + gx * CELL), wrap(y + gy * CELL)), wgt]); wsum += wgt; }
    const take = Math.min(amount, this.sediment); this.sediment -= take;
    for (const [p, wgt] of cells) this.N[p] += take * wgt / wsum;
  }
  stagnant() { // no new established species in the last seven days
    if (this.t < 7 * 86400) return false;
    return !(this.lastEstablishedAt > this.t - 7 * 86400);
  }
  impact(x = this.rng.range(0, WORLD), y = this.rng.range(0, WORLD)) {
    this.meteors++;
    this.meteor = { at: this.t, x, y, dark: this.rng.range(1, 2) * 86400 };
    let killed = 0;
    for (const c of this.creatures) {
      if (c.dead) continue;
      const dx = wrapD(c.x - x), dy = wrapD(c.y - y);
      if (dx * dx + dy * dy < 60 * 60) { this.die(c, 'impact', cellOf(c.x, c.y)); killed++; }
    }
    this.creatures = this.creatures.filter(c => !c.dead);
    this.toxic(x, y, 60, 1);
    this.event('meteor', { x: x / WORLD, y: y / WORLD, killed, darkHours: Math.round(this.meteor.dark / 3600), stagnant: this.stagnant() });
  }
  eruption(x = this.rng.range(0, WORLD), y = this.rng.range(0, WORLD)) {
    this.volcanoes++;
    this.toxic(x, y, 30, 1);
    // The eruption returns buried matter to the water around the vent.
    const release = this.sediment * .4, cells = [];
    for (let gy = -10; gy <= 10; gy++) for (let gx = -10; gx <= 10; gx++) if (gx * gx + gy * gy <= 100)
      cells.push(cellOf(wrap(x + gx * CELL), wrap(y + gy * CELL)));
    for (const p of cells) this.N[p] += release / cells.length;
    this.sediment -= release;
    this.event('eruption', { x: x / WORLD, y: y / WORLD, released: Math.round(release) });
    this.pendingGermination = this.t + 6 * 3600;
  }
  toxic(x, y, r, v) {
    const n = Math.ceil(r / CELL);
    for (let gy = -n; gy <= n; gy++) for (let gx = -n; gx <= n; gx++) {
      const d = Math.hypot(gx, gy) * CELL; if (d > r) continue;
      const p = cellOf(wrap(x + gx * CELL), wrap(y + gy * CELL));
      this.T[p] = Math.max(this.T[p], v * (1 - d / r * .5));
    }
  }
  // Dormant spores of past species wake up; their matter is drawn from the water.
  germinate(count, reason, filter = () => true) {
    const pool = this.spores.filter(s => filter(s.g));
    if (!pool.length) return 0;
    let total = 0; for (const v of this.N) total += v;
    let made = 0;
    for (let i = 0; i < count; i++) {
      const sp = pool[this.rng.int(pool.length)], g = mutate(cloneGenome(sp.g), this.rng, .5), p = phenotype(g);
      const need = p.mass + p.cap * .4;
      if (total < need * 4) break;
      const scale = 1 - need / total; for (let k = 0; k < this.N.length; k++) this.N[k] *= scale; total -= need;
      let x = 0, y = 0;
      for (let tries = 0; tries < 30; tries++) { x = this.rng.range(0, WORLD); y = this.rng.range(0, WORLD); if (this.shallow[cellOf(x, y)] > .3 && this.T[cellOf(x, y)] < .05) break; }
      const c = this.spawn(g, x, y, null, p.cap * .4);
      c.lazarus = sp.species; made++;
      const s = this.species.get(c.sp);
      if (sp.species && s && s.born === this.t) s.lazarus = sp.species;
    }
    if (made) { this.counters.germinated += made; this.event('germination', { count: made, reason }); }
    return made;
  }

  // ---------- once per simulated minute ----------
  minute() {
    if (this.pendingGermination && this.t >= this.pendingGermination) { this.pendingGermination = 0; this.germinate(3, 'after_eruption'); }
    const roles = { producer: 0, grazer: 0, predator: 0, scavenger: 0, none: 0 }, biomass = { producer: 0, grazer: 0, predator: 0, scavenger: 0, none: 0 };
    let animals = 0, infected = 0;
    const traits = { bite: 0, armor: 0, thrust: 0, eye: 0, glow: 0, fat: 0, mass: 0, diet: 0, modules: 0 };
    const flora = { photo: 0, armor: 0, mass: 0, modules: 0, scale: 0, n: 0 };
    for (const c of this.creatures) {
      const r = roleOf(c.intake, c.p);
      roles[r]++; biomass[r] += c.p.mass + c.e;
      if (c.inf) infected++;
      if (!c.p.acts && c.p.photo > 0) { flora.n++; flora.photo += c.p.photo / c.scale; flora.armor += c.p.armor / c.scale; flora.mass += c.p.mass; flora.modules += c.g.modules.length; flora.scale += c.scale; }
      if (c.p.thrust > 0 && c.p.bite > 0) {
        animals++;
        traits.bite += c.p.bite; traits.armor += c.p.armor; traits.thrust += c.p.thrust; traits.eye += c.p.eye;
        traits.glow += c.p.glow; traits.fat += c.p.fat; traits.mass += c.p.mass; traits.diet += c.g.diet; traits.modules += c.g.modules.length;
      }
    }
    for (const k in traits) traits[k] = animals ? traits[k] / animals : 0;
    for (const k of ['photo', 'armor', 'mass', 'modules', 'scale']) flora[k] = flora.n ? flora[k] / flora.n : 0;
    // Species census and establishment.
    for (const s of this.species.values()) {
      if (s.count <= 0) continue;
      if (s.count > s.peak) s.peak = s.count;
      if (!s.established && s.count >= 15) {
        s.established = true; s.establishedAt = this.t; this.lastEstablishedAt = this.t; this.counters.established++;
        this.event('speciation', { species: s.id, parent: s.parent, count: s.count, lazarus: s.lazarus || null });
      }
    }
    if (this.tick % (HZ * 600) === 0) this.censusSpecies();
    let live = 0, est = 0; for (const s of this.species.values()) if (s.count > 0) { live++; if (s.established) est++; }
    const total = this.creatures.reduce((m, c) => m + c.p.mass + c.e, 0);
    let algae = 0; for (const v of this.A) algae += v;
    const row = { t: this.t, epoch: this.epoch, n: this.creatures.length, algae, roles, biomass, animals, infected, species: live, established: est,
      light: this.globalLight, climate: this.climate, dust: this.dust, sediment: this.sediment, matter: this.matter(), traits, flora, total };
    this.history.push(row); if (this.history.length > 60 * 24 * 3) this.history.shift();
    this.epochs(row);
    // Safety net against an empty world: dormant spores, never hand-made organisms.
    if (animals === 0) { this.animalAbsentSince ??= this.t; if (this.t - this.animalAbsentSince > 3600) { this.germinate(Math.round(40 * AREA), 'no_animals', g => phenotype(g).bite > 0 && phenotype(g).thrust > 0); this.animalAbsentSince = this.t; } }
    else this.animalAbsentSince = null;
    if (this.creatures.length < 120 * AREA) this.germinate(Math.round(160 * AREA), 'near_empty');
  }

  censusSpecies() {
    // Extinct species leave live memory a day after their last member; the fossil
    // record and the spore bank keep what history needs.
    for (const [id, s] of this.species) if (s.count <= 0 && s.died !== null && s.died < this.t - 86400) this.species.delete(id);
    // Representative signature follows the living population; a sample genome is kept for the record.
    const acc = new Map();
    for (const c of this.creatures) {
      let a = acc.get(c.sp); if (!a) { a = { sig: new Float32Array(c.sig.length), n: 0, pick: c, intake: [0, 0, 0, 0] }; acc.set(c.sp, a); }
      for (let i = 0; i < c.sig.length; i++) a.sig[i] += c.sig[i];
      for (let i = 0; i < 4; i++) a.intake[i] += c.intake[i];
      a.n++; if (this.rng.chance(1 / a.n)) a.pick = c;
    }
    for (const [id, a] of acc) {
      const s = this.species.get(id); if (!s) continue;
      for (let i = 0; i < a.sig.length; i++) s.rep[i] = a.sig[i] / a.n;
      s.sample = cloneGenome(a.pick.g); s.count = a.n;
      const r = roleOf(a.intake, phenotype(s.sample)); // measured from what living members actually ate
      if (s.established && r !== s.role && r === 'predator' && !this.firsts.predator) {
        this.firsts.predator = this.t; this.event('first_predator', { species: s.id, count: s.count });
      }
      if (s.established && r === 'scavenger' && !this.firsts.scavenger) { this.firsts.scavenger = this.t; this.event('first_scavenger', { species: s.id }); }
      if (s.established) this.firstPlans(s);
      s.role = r;
    }
  }

  // The first established species of a new body plan is news: radial symmetry, tentacles,
  // spines, a very long body.
  firstPlans(s) {
    const g = s.sample, p = phenotype(g);
    const plans = p.acts ? [['radial', g.sym > 0], ['tentacles', p.tent > 0], ['spines', p.spine > 0], ['long', g.elong > 2], ['segmented', g.seg > 1]]
      : [['spiny_plant', p.spine > 0], ['filament', p.form === FORM.FILAMENT], ['bush', p.form === FORM.BUSH], ['kelp', p.form === FORM.KELP], ['runner', p.form === FORM.RUNNER],
        ['colony_plant', p.form === FORM.COLONY], ['diatom', p.form === FORM.DIATOM]];
    for (const [plan, has] of plans) if (has && !this.firsts[plan]) {
      this.firsts[plan] = this.t; this.event('first_plan', { plan, species: s.id, rays: g.sym || undefined, count: s.count });
    }
  }

  epochs(row) {
    // A new epoch begins when the hourly mean of living biomass falls below 40% of
    // the highest hourly mean of the previous day. The first two days are genesis.
    const hourMean = from => { let sum = 0, n = 0; for (let i = this.history.length - 1; i >= 0 && this.history[i].t > from - 3600; i--) if (this.history[i].t <= from) { sum += this.history[i].total; n++; } return n ? sum / n : 0; };
    const now = hourMean(this.t);
    let max = 0; for (let k = 1; k <= 24; k++) max = Math.max(max, hourMean(this.t - k * 3600));
    if (!this.crash && this.t > 2 * 86400 && now < max * .4 && this.t - this.lastEpochAt > 86400) {
      this.crash = { at: this.t, from: max };
      const cause = this.meteor ? 'meteor' : this.climate < .72 ? 'ice' : this.strains.size && [...this.strains.values()].some(s => s.infected > 50) ? 'plague' : 'collapse';
      this.epoch++; this.lastEpochAt = this.t;
      this.event('epoch', { cause, lost: 1 - now / max, survivors: this.creatures.length, species: row.species });
    }
    if (this.crash && now > this.crash.from * .7) { this.event('recovery', { hours: (this.t - this.crash.at) / 3600 }); this.crash = null; }
    if (this.climate < .72 && !this.iceAge) { this.iceAge = this.t; this.event('ice_age_start', { climate: this.climate }); }
    if (this.climate > .78 && this.iceAge) { this.event('ice_age_end', { days: (this.t - this.iceAge) / 86400 }); this.iceAge = null; }
  }

  // ---------- persistence ----------
  export() {
    return { version: VERSION, seed: this.seed, rng: this.rng.s, t: this.t, tick: this.tick, nextId: this.nextId, nextSpecies: this.nextSpecies,
      nextStrain: this.nextStrain, epoch: this.epoch, eventSeq: this.eventSeq, fossilSeq: this.fossilSeq, N: this.N, D: this.D, T: this.T, A: this.A, sediment: this.sediment, climatePhases: this.climatePhases,
      creatures: this.creatures.map(c => { const { p, sig, mate, est, adultP, ...rest } = c; return rest; }),
      species: [...this.species.values()], strains: [...this.strains.values()], spores: this.spores, fossils: this.fossils,
      events: this.events, history: this.history, counters: this.counters, meteor: this.meteor, weather: this.weather, volcanoes: this.volcanoes, meteors: this.meteors,
      animalAbsentSince: this.animalAbsentSince, lastEpochAt: this.lastEpochAt, crash: this.crash, firsts: this.firsts,
      lastEstablishedAt: this.lastEstablishedAt, rowsTick: undefined, photoLoad: this.photoLoad, tallLoad: this.tallLoad, canopyLoad: this.canopyLoad, pendingGermination: this.pendingGermination, iceAge: this.iceAge, matter0: this.matter0, layout: this.layout };
  }
  static restore(s) {
    if (s.version !== VERSION) throw Error('Unsupported world version');
    if (s.N?.length !== GRID * GRID) throw Error(`Checkpoint is for another world size; this engine runs ${WORLD}×${WORLD}`);
    const w = Object.create(World.prototype);
    Object.assign(w, s);
    w.rng = new Rng(1); w.rng.s = s.rng;
    const load = s.photoLoad, tall = s.tallLoad, canopy = s.canopyLoad;
    for (const g of [...s.creatures.map(c => c.g), ...s.species.map(x => x.sample), ...s.spores.map(x => x.g)]) settlePlan(g); // body plans: old genomes are bilateral
    { // signatures grew with body plans and growth forms; older bodies have none of them
      const grow = a => { if (a.length >= SIG) return a; const b = new Float32Array(SIG); b.set(a); return b; };
      for (const x of s.species) x.rep = grow(x.rep);
      for (const x of s.strains) x.sig = grow(x.sig);
    }
    if (!s.layout) { // organ placement gained an effect: settle genomes written while it was neutral
      for (const c of s.creatures) if (phenotype(c.g).acts) settleLayout(c.g);
      for (const x of s.species) if (phenotype(x.sample).acts) settleLayout(x.sample);
      for (const x of s.spores) if (phenotype(x.g).acts) settleLayout(x.g);
    }
    w.layout = 3;
    if (w.firsts?.spinyPlant) { w.firsts.spiny_plant = w.firsts.spinyPlant; delete w.firsts.spinyPlant; }
    w.species = new Map(s.species.map(x => [x.id, x])); w.strains = new Map(s.strains.map(x => [x.id, x]));
    w.creatures = s.creatures.map(c => { if (!validGenome(c.g) || !(c.scale > 0 && c.scale <= 1)) throw Error('Invalid creature'); return creature({ ...c, p: phenotype(c.g, c.scale), sig: signature(c.g) }); });
    w.init();
    if (load) w.photoLoad.set(load);
    if (tall) w.tallLoad.set(tall);
    if (canopy) w.canopyLoad.set(canopy);
    return w;
  }
}

export function roleOf(intake, p) {
  const [photo, plant, meat, det] = intake, total = photo + plant + meat + det;
  if (total <= 0) return p.photo > 0 && !p.acts ? 'producer' : p.bite > 0 ? 'grazer' : 'none';
  if (photo / total >= .5) return 'producer';
  if (meat / total >= .5) return 'predator';
  if (det / total >= .5) return 'scavenger';
  if (plant / total >= .5) return 'grazer';
  return meat > plant ? 'predator' : 'grazer';
}
