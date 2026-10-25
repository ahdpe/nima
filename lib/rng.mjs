// Deterministic xorshift32. All world randomness flows through one stream, so a
// checkpoint plus the same code reproduces the same history on the same runtime.
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 1; }
  next() { let x = this.s; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.s = x >>> 0; return this.s / 4294967296; }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n); }
  normal() { // Irwin–Hall approximation with unit variance: cheap, bounded, deterministic.
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }
  chance(p) { return this.next() < p; }
}
