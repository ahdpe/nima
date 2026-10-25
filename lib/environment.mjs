// Abiotic world: a toroidal ocean lit by a moving day, a migrating seasonal
// belt and three long climate waves; shallow banks drift over weeks.
// The production world is 1024 units; experiments may use a smaller torus with the same densities.
export const WORLD = Number(globalThis.process?.env?.EPOCHS_WORLD || 1024); // world units per side (torus)
export const GRID = WORLD / 4;        // environmental field resolution (4-unit cells)
export const CELL = WORLD / GRID;    // 4 units
export const DAY = 15 * 60;          // seconds of real time
export const YEAR = 24 * 3600;
export const CLIMATE = [11, 17, 29].map(d => d * 86400); // coprime periods: pattern repeats after 5423 days
const TAU = Math.PI * 2;
const AMP = [.17, .13, .11];

export function climate(t, phases) {
  let c = 1;
  for (let i = 0; i < 3; i++) c += AMP[i] * Math.sin(TAU * t / CLIMATE[i] + phases[i]);
  return c;
}

// Insolation at a point, before shading and dust: day × season belt × climate × depth.
export function sun(t) {
  const sunX = ((t / DAY) % 1) * WORLD;
  const belt = (.5 + .16 * Math.sin(TAU * t / YEAR)) * WORLD; // the warm belt drifts north and south over the year
  const yearLight = .85 + .15 * Math.cos(TAU * t / YEAR * 2);
  return { sunX, belt, yearLight };
}

export function makeLightColumns(t, s, out) { // day factor by column
  for (let gx = 0; gx < GRID; gx++) {
    const h = TAU * ((gx + .5) * CELL - s.sunX) / WORLD;
    const d = .2 + .8 * Math.cos(h);
    out[gx] = d > 0 ? Math.min(1, d) : 0;
  }
}
export function makeLightRows(s, out) { // seasonal belt by row
  for (let gy = 0; gy < GRID; gy++) {
    const phi = TAU * ((gy + .5) * CELL - s.belt) / WORLD;
    out[gy] = .12 + .88 * ((1 + Math.cos(phi)) / 2) ** 1.5;
  }
}

// Tileable value noise on the torus, used for drifting shallow banks.
function lattice(seed, n) {
  const v = new Float32Array(n * n); let x = seed >>> 0 || 1;
  for (let i = 0; i < v.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; v[i] = x / 4294967296; }
  return v;
}
const fade = t => t * t * (3 - 2 * t);
function noise(lat, n, x, y) { // x, y in lattice units, periodic in n
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = fade(x - x0), fy = fade(y - y0);
  const i0 = ((x0 % n) + n) % n, j0 = ((y0 % n) + n) % n, i1 = (i0 + 1) % n, j1 = (j0 + 1) % n;
  const a = lat[j0 * n + i0], b = lat[j0 * n + i1], c = lat[j1 * n + i0], d = lat[j1 * n + i1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// Archipelago: a few large islands of shallow water that wander on slow orbits of
// several weeks, separated by deep straits. Coasts get detail from small noise.
export const ISLANDS = Number(globalThis.process?.env?.EPOCHS_ISLANDS || 0);
const torusD = d => { d = ((d % WORLD) + WORLD) % WORLD; return d > WORLD / 2 ? d - WORLD : d; };

export class Seafloor {
  constructor(seed) {
    this.seed = seed;
    let x = (seed * 2654435761) >>> 0 || 1; const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
    this.islands = Array.from({ length: ISLANDS }, (_, i) => ({
      cx: ((i + rnd() * .8) / ISLANDS) * WORLD, cy: rnd() * WORLD, r: WORLD * (.052 + .034 * rnd()),
      ax: WORLD * (.04 + .08 * rnd()), ay: WORLD * (.04 + .08 * rnd()), px: (17 + 24 * rnd()) * 86400, py: (19 + 26 * rnd()) * 86400, p0: rnd() * TAU, p1: rnd() * TAU }));
    const big = Math.round(12 * WORLD / 1024), small = big * 2; this.big = big; this.small = small;
    this.layers = [lattice(seed, big), lattice(seed * 7 + 3, big), lattice(seed * 13 + 5, small), lattice(seed * 17 + 11, small)];
  }
  // Shallowness in [0, 1]. Banks drift one world-width per ~40 days and morph over ~9 days.
  fill(t, out) {
    const drift = t / (40 * 86400), morph = (Math.sin(TAU * t / (9 * 86400)) + 1) / 2;
    const [a, b, c, d] = this.layers;
    for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
      const u = gx / GRID, v = gy / GRID;
      const B = this.big, S = this.small;
      const big = noise(a, B, (u + drift) * B, (v + drift * .37) * B) * (1 - morph) + noise(b, B, (u - drift * .6) * B, (v + drift * .8) * B) * morph;
      const small = noise(c, S, (u + drift) * S, (v - drift * .5) * S) * (1 - morph) + noise(d, S, (u - drift * .3) * S, (v + drift) * S) * morph;
      let h = big * .75 + small * .25, s = (h - .52) / .12;
      if (ISLANDS) {
        const wx = u * WORLD, wy = v * WORLD; let m = 0;
        for (const isl of this.islands) {
          const cx = isl.cx + isl.ax * Math.sin(TAU * t / isl.px + isl.p0), cy = isl.cy + isl.ay * Math.sin(TAU * t / isl.py + isl.p1);
          const dx = torusD(wx - cx), dy = torusD(wy - cy), e = Math.exp(-(dx * dx + dy * dy) / (isl.r * isl.r));
          if (e > m) m = e;
        }
        h = m * .9 + (small - .5) * .45 + (big - .5) * .2;
        s = (h - .38) / .16;
      }
      out[gy * GRID + gx] = s <= 0 ? 0 : s >= 1 ? 1 : s * s * (3 - 2 * s);
    }
  }
}
