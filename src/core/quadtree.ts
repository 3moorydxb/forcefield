import type { Graph } from './graph.js';
import { FLAG_HIDDEN } from './graph.js';
import type { Rng } from '../util/rng.js';

/**
 * Barnes-Hut quadtree.
 *
 * WHY: naive many-body repulsion is O(n²) — every node against every other. At
 * a few thousand nodes that is millions of pair checks *per frame*: measured on
 * one 2,864-node graph, the naive version costs 79.8 ms per tick, which is 12fps
 * before anything is drawn. Barnes-Hut groups distant nodes into their centre of
 * mass and treats the group as one body, giving O(n log n) — 23× faster on that
 * same graph, and the gap widens with size.
 *
 * Structure is flat arrays rather than objects: one tree is rebuilt every tick,
 * and allocating ~10k short-lived objects 60 times a second is how a simulation
 * ends up spending its frame budget in the garbage collector instead of in
 * physics. The arrays are reused across rebuilds and only ever grow.
 *
 * Cell indices increase with depth (children are always allocated after their
 * parent), which is what lets `finalise()` accumulate masses in a single reverse
 * sweep instead of a recursive post-order walk.
 */
export class Quadtree {
  /** Number of cells currently in use. */
  count = 0;

  // Cell geometry.
  cx: Float64Array;
  cy: Float64Array;
  /** Half the side length of the cell's square. */
  half: Float64Array;

  // Cell aggregates, filled by `finalise()`.
  /** Σ|charge| over the subtree — the weight the centre of mass is computed with. */
  mass: Float64Array;
  /**
   * Σcharge over the subtree, signed. The force step needs the signed total;
   * the centre of mass needs the magnitude. Keeping both means a graph that
   * mixes repelling and attracting nodes still has a defined centre.
   */
  charge: Float64Array;
  comX: Float64Array;
  comY: Float64Array;
  /** Largest body radius anywhere in this subtree — lets collision prune. */
  maxR: Float64Array;
  /** Number of bodies in this subtree. */
  bodies: Uint32Array;

  /** 4 entries per cell; `-1` means the cell is a leaf in that quadrant. */
  child: Int32Array;
  /** First body index in this leaf, or `-1`. */
  bodyHead: Int32Array;
  /** Next body in the same leaf's chain, or `-1`. Indexed by graph node index. */
  bodyNext: Int32Array;

  private capacity = 0;
  private bodyCapacity = 0;

  /**
   * Depth cap. Two nodes at *identical* coordinates would otherwise subdivide
   * forever; at the cap they chain into the same leaf instead. 26 levels is a
   * ~67-million-fold reduction from the root cell, far below Float64 resolution
   * at any coordinate scale a screen uses.
   */
  readonly maxDepth = 26;

  constructor(cellCapacity = 1024, bodyCapacity = 1024) {
    this.capacity = cellCapacity;
    this.bodyCapacity = bodyCapacity;
    this.cx = new Float64Array(cellCapacity);
    this.cy = new Float64Array(cellCapacity);
    this.half = new Float64Array(cellCapacity);
    this.mass = new Float64Array(cellCapacity);
    this.charge = new Float64Array(cellCapacity);
    this.comX = new Float64Array(cellCapacity);
    this.comY = new Float64Array(cellCapacity);
    this.maxR = new Float64Array(cellCapacity);
    this.bodies = new Uint32Array(cellCapacity);
    this.child = new Int32Array(cellCapacity * 4);
    this.bodyHead = new Int32Array(cellCapacity);
    this.bodyNext = new Int32Array(bodyCapacity);
  }

  /**
   * Rebuild over every non-hidden node.
   *
   * Hidden nodes are absent from the tree entirely, which is what makes filtering
   * cheap: a filtered-out subtree costs nothing per frame, it does not merely
   * skip drawing.
   *
   * `rng` is used only to separate bodies that sit at exactly the same point.
   * Without it they produce a zero-distance pair and an infinite force.
   */
  build(g: Graph, rng: Rng): void {
    const n = g.nodeCount;
    this.count = 0;
    if (n === 0) return;

    if (this.bodyCapacity < n) {
      this.bodyCapacity = nextPow2(n);
      this.bodyNext = new Int32Array(this.bodyCapacity);
    }

    // 1. bounds over active nodes only.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let active = 0;
    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      const px = g.x[i]!;
      const py = g.y[i]!;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      active++;
    }
    if (active === 0) return;

    // Square root cell, padded so a body never sits exactly on the boundary.
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const half = Math.max(maxX - minX, maxY - minY) / 2 + 1;

    this.ensureCells(64);
    this.newCell(cx, cy, half);

    // 2. insert.
    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      this.insert(g, i, rng);
    }

    // 3. aggregate.
    this.finalise(g);
  }

  private insert(g: Graph, b: number, rng: Rng): void {
    let cur = 0;
    let depth = 0;

    for (;;) {
      if (this.child[cur * 4]! >= 0) {
        cur = this.descend(g, cur, b);
        depth++;
        continue;
      }

      const occupant = this.bodyHead[cur]!;
      if (occupant < 0) {
        this.bodyHead[cur] = b;
        this.bodyNext[b] = -1;
        return;
      }

      if (depth >= this.maxDepth) {
        // Coincident (or near-coincident) bodies. Chain them and nudge this one
        // so the pair force has a direction to work with instead of dividing by
        // zero. The nudge comes from the seeded stream, so it is reproducible.
        const j = rng.discPoint(1e-3);
        g.x[b]! += j.x;
        g.y[b]! += j.y;
        this.bodyNext[b] = occupant;
        this.bodyHead[cur] = b;
        return;
      }

      // Split: push the sitting body one level down, then carry on with ours.
      this.bodyHead[cur] = -1;
      this.subdivide(cur);
      const home = this.descend(g, cur, occupant);
      this.bodyHead[home] = occupant;
      this.bodyNext[occupant] = -1;

      cur = this.descend(g, cur, b);
      depth++;
    }
  }

  private descend(g: Graph, cell: number, b: number): number {
    const q = (g.x[b]! >= this.cx[cell]! ? 1 : 0) | (g.y[b]! >= this.cy[cell]! ? 2 : 0);
    return this.child[cell * 4 + q]!;
  }

  private subdivide(cell: number): void {
    this.ensureCells(this.count + 4);
    const h = this.half[cell]! / 2;
    const x = this.cx[cell]!;
    const y = this.cy[cell]!;
    // Order matches the quadrant bits in `descend`: bit0 = +x, bit1 = +y.
    this.child[cell * 4 + 0] = this.newCell(x - h, y - h, h);
    this.child[cell * 4 + 1] = this.newCell(x + h, y - h, h);
    this.child[cell * 4 + 2] = this.newCell(x - h, y + h, h);
    this.child[cell * 4 + 3] = this.newCell(x + h, y + h, h);
  }

  private newCell(x: number, y: number, half: number): number {
    const c = this.count++;
    this.cx[c] = x;
    this.cy[c] = y;
    this.half[c] = half;
    this.mass[c] = 0;
    this.charge[c] = 0;
    this.comX[c] = 0;
    this.comY[c] = 0;
    this.maxR[c] = 0;
    this.bodies[c] = 0;
    this.bodyHead[c] = -1;
    const base = c * 4;
    this.child[base] = -1;
    this.child[base + 1] = -1;
    this.child[base + 2] = -1;
    this.child[base + 3] = -1;
    return c;
  }

  /**
   * Accumulate mass, centre of mass and max radius bottom-up.
   *
   * A single reverse sweep is correct because a child cell's index is always
   * greater than its parent's — `subdivide` allocates children after the parent
   * and cells are never reordered.
   */
  private finalise(g: Graph): void {
    for (let c = this.count - 1; c >= 0; c--) {
      const base = c * 4;
      let m = 0;
      let q = 0;
      let sx = 0;
      let sy = 0;
      let mr = 0;
      let cnt = 0;

      if (this.child[base]! >= 0) {
        for (let k = 0; k < 4; k++) {
          const ch = this.child[base + k]!;
          if (this.bodies[ch]! === 0) continue;
          const cm = this.mass[ch]!;
          m += cm;
          q += this.charge[ch]!;
          sx += this.comX[ch]! * cm;
          sy += this.comY[ch]! * cm;
          if (this.maxR[ch]! > mr) mr = this.maxR[ch]!;
          cnt += this.bodies[ch]!;
        }
      } else {
        for (let b = this.bodyHead[c]!; b >= 0; b = this.bodyNext[b]!) {
          // Charge is what the repulsion step aggregates. Inertial mass is a
          // separate array applied per node during integration, not here.
          const bq = g.charge[b]!;
          const bm = Math.abs(bq);
          m += bm;
          q += bq;
          sx += g.x[b]! * bm;
          sy += g.y[b]! * bm;
          if (g.radius[b]! > mr) mr = g.radius[b]!;
          cnt++;
        }
      }

      this.mass[c] = m;
      this.charge[c] = q;
      this.comX[c] = m > 0 ? sx / m : this.cx[c]!;
      this.comY[c] = m > 0 ? sy / m : this.cy[c]!;
      this.maxR[c] = mr;
      this.bodies[c] = cnt;
    }
  }

  /** A cell with no children holds its bodies directly in `bodyHead`. */
  isLeaf(cell: number): boolean {
    return this.child[cell * 4]! < 0;
  }

  private ensureCells(need: number): void {
    if (need <= this.capacity) return;
    const cap = nextPow2(need);
    this.cx = growF(this.cx, cap);
    this.cy = growF(this.cy, cap);
    this.half = growF(this.half, cap);
    this.mass = growF(this.mass, cap);
    this.charge = growF(this.charge, cap);
    this.comX = growF(this.comX, cap);
    this.comY = growF(this.comY, cap);
    this.maxR = growF(this.maxR, cap);
    const b = new Uint32Array(cap);
    b.set(this.bodies);
    this.bodies = b;
    const ch = new Int32Array(cap * 4);
    ch.set(this.child);
    this.child = ch;
    const bh = new Int32Array(cap);
    bh.set(this.bodyHead);
    this.bodyHead = bh;
    this.capacity = cap;
  }
}

function growF(src: Float64Array, cap: number): Float64Array {
  const a = new Float64Array(cap);
  a.set(src);
  return a;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
