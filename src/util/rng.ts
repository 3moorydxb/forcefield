/**
 * Deterministic PRNG (mulberry32).
 *
 * A layout that uses `Math.random()` cannot be reproduced, which means a layout
 * bug cannot be reproduced either. Every source of randomness in this engine —
 * initial placement, degenerate-position jitter, sampling — draws from one seeded
 * stream so that the same graph plus the same seed gives the same layout.
 */
export class Rng {
  private s: number;

  constructor(seed = 0x9e3779b9) {
    // Force to uint32 so a float or a negative seed still behaves.
    this.s = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  between(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** A point uniformly distributed inside a disc of `radius` around the origin. */
  discPoint(radius: number): { x: number; y: number } {
    const a = this.next() * Math.PI * 2;
    const r = Math.sqrt(this.next()) * radius;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }
}
