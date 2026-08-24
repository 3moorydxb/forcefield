import { Graph, FLAG_DRAGGING, FLAG_HIDDEN, FLAG_PINNED } from './graph.js';
import { Quadtree } from './quadtree.js';
import { Rng } from '../util/rng.js';
import type { Force, ForceContext } from './forces/types.js';
import { ManyBodyForce } from './forces/manyBody.js';
import { LinkForce } from './forces/link.js';
import { CenterForce, GravityForce } from './forces/center.js';
import { CollideForce } from './forces/collide.js';

export interface SimulationConfig {
  /** Integration step. Leave at 1 and tune the forces; this is a knob for stiff graphs. */
  dt?: number;
  /** Fraction of the remaining gap to `alphaTarget` closed per tick. */
  alphaDecay?: number;
  /** Below this the simulation is considered settled and stops ticking. */
  alphaMin?: number;
  /** Where alpha is heading. Held above `alphaMin` while a drag is in progress. */
  alphaTarget?: number;
  /** Velocity multiplier per tick, `(0, 1]`. Lower = more viscous, settles sooner. */
  damping?: number;
  seed?: number;
}

type Listener = (sim: Simulation) => void;

/**
 * The simulation.
 *
 * **Integration is velocity-Verlet**, not the semi-implicit Euler most graph
 * layouts use. Verlet carries the previous acceleration and averages it with the
 * new one, which is second-order accurate rather than first: the same layout
 * settles in fewer ticks and, more visibly, a dragged node's neighbours trail it
 * smoothly instead of overshooting and snapping back. That costs one extra pair
 * of arrays and nothing per frame.
 *
 * **Alpha** is a global cooling factor every force multiplies by. It decays
 * geometrically toward `alphaTarget`; when it drops under `alphaMin` the graph
 * is settled and the loop can stop drawing. Any interaction calls `reheat()`,
 * which is what makes a settled graph come alive under the cursor and go quiet
 * again afterwards.
 *
 * A tick, in order:
 *   1. drift free nodes   `x += v·dt + ½a·dt²`
 *   2. `pre` forces       (centring — a translation, before the tree is built)
 *   3. build the quadtree (over non-hidden nodes only)
 *   4. `relax` forces     (collision — positional, uses the tree)
 *   5. `force` forces     (repulsion, springs, gravity → force scratch)
 *   6. kick               `v += ½(a + a')·dt`, then damp; `a ← a'`
 *   7. cool               `alpha += (alphaTarget − alpha)·alphaDecay`
 *
 * Pinned, dragged and hidden nodes never drift and never take a kick. Pinned and
 * dragged nodes ARE in the quadtree and ARE on their springs, so they go on
 * pushing the graph around while standing still — which is the point of a pin.
 * Hidden nodes are absent from the tree entirely and their coordinates are
 * frozen, which is what makes filtering reversible.
 */
export class Simulation {
  readonly graph: Graph;
  readonly tree = new Quadtree();
  readonly rng: Rng;
  readonly forces: Force[] = [];

  alpha = 1;
  alphaTarget: number;
  alphaDecay: number;
  alphaMin: number;
  damping: number;
  dt: number;

  private fx: Float64Array;
  private fy: Float64Array;
  private capacity: number;
  private listeners: Record<string, Listener[]> = {};
  private knownVersion = -1;

  constructor(graph: Graph, config: SimulationConfig = {}) {
    this.graph = graph;
    this.dt = config.dt ?? 1;
    // d3's default, derived from "settle in about 300 ticks": 1 − alphaMin^(1/300).
    this.alphaDecay = config.alphaDecay ?? 0.0228;
    this.alphaMin = config.alphaMin ?? 0.001;
    this.alphaTarget = config.alphaTarget ?? 0;
    this.damping = config.damping ?? 0.6;
    this.rng = new Rng(config.seed ?? 0x5eed1e);

    this.capacity = Math.max(64, graph.nodeCount);
    this.fx = new Float64Array(this.capacity);
    this.fy = new Float64Array(this.capacity);

    this.forces.push(
      new CenterForce(),
      new CollideForce(),
      new ManyBodyForce(),
      new LinkForce(),
      new GravityForce(),
    );
  }

  /** Typed lookup by name, e.g. `sim.force<LinkForce>('link')!.distance = 60`. */
  force<T extends Force = Force>(name: string): T | undefined {
    return this.forces.find((f) => f.name === name) as T | undefined;
  }

  addForce(f: Force): void {
    this.forces.push(f);
    f.initialize?.(this.graph);
  }

  removeForce(name: string): void {
    const i = this.forces.findIndex((f) => f.name === name);
    if (i >= 0) this.forces.splice(i, 1);
  }

  get settled(): boolean {
    return this.alpha < this.alphaMin;
  }

  /** Full restart — only for a genuinely new graph. Filtering must NOT call this. */
  restart(alpha = 1): this {
    this.alpha = alpha;
    return this;
  }

  /**
   * Raise alpha without dropping below where it already is.
   *
   * This is the "reheats on interaction" behaviour: a settled graph that is
   * dragged, filtered-and-refit, or has a node inserted into it wakes up, moves,
   * and cools again. Note it never *lowers* alpha, so a reheat during an active
   * simulation cannot stall it.
   */
  reheat(to = 0.3): this {
    if (to > this.alpha) this.alpha = to;
    return this;
  }

  /** Run `count` ticks synchronously. Returns the number actually run. */
  tick(count = 1): number {
    let ran = 0;
    for (let k = 0; k < count; k++) {
      if (this.alpha < this.alphaMin && this.alphaTarget < this.alphaMin) break;
      this.step();
      ran++;
    }
    if (ran > 0) this.emit('tick');
    if (this.settled) this.emit('end');
    return ran;
  }

  private step(): void {
    const g = this.graph;
    const n = g.nodeCount;

    if (this.capacity < n) {
      this.capacity = nextPow2(n);
      this.fx = new Float64Array(this.capacity);
      this.fy = new Float64Array(this.capacity);
    }
    if (this.knownVersion !== g.version) {
      for (const f of this.forces) f.initialize?.(g);
      this.knownVersion = g.version;
    }

    const dt = this.dt;
    const halfDt2 = 0.5 * dt * dt;
    const FIXED = FLAG_PINNED | FLAG_DRAGGING | FLAG_HIDDEN;

    // 1. drift
    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FIXED) continue;
      g.x[i]! += g.vx[i]! * dt + g.ax[i]! * halfDt2;
      g.y[i]! += g.vy[i]! * dt + g.ay[i]! * halfDt2;
    }

    const ctx: ForceContext = {
      graph: g,
      tree: this.tree,
      alpha: this.alpha,
      dt,
      rng: this.rng,
      fx: this.fx,
      fy: this.fy,
    };

    // 2. pre (no tree)
    for (const f of this.forces) {
      if (f.enabled && f.phase === 'pre') f.apply(ctx);
    }

    // 3. tree
    this.tree.build(g, this.rng);

    // 4. relax (tree)
    for (const f of this.forces) {
      if (f.enabled && f.phase === 'relax') f.apply(ctx);
    }

    // 5. forces
    this.fx.fill(0, 0, n);
    this.fy.fill(0, 0, n);
    for (const f of this.forces) {
      if (f.enabled && f.phase === 'force') f.apply(ctx);
    }

    // 6. kick + damp
    const damping = this.damping;
    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FIXED) {
        g.vx[i] = 0;
        g.vy[i] = 0;
        g.ax[i] = 0;
        g.ay[i] = 0;
        continue;
      }
      const m = g.mass[i]!;
      const nax = this.fx[i]! / m;
      const nay = this.fy[i]! / m;
      g.vx[i]! += 0.5 * (g.ax[i]! + nax) * dt;
      g.vy[i]! += 0.5 * (g.ay[i]! + nay) * dt;
      g.vx[i]! *= damping;
      g.vy[i]! *= damping;
      g.ax[i] = nax;
      g.ay[i] = nay;
    }

    // 7. cool
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
  }

  /** Total kinetic energy of the free nodes — the honest "has it settled" measure. */
  kineticEnergy(): number {
    const g = this.graph;
    let e = 0;
    for (let i = 0; i < g.nodeCount; i++) {
      if (g.flags[i]! & (FLAG_HIDDEN | FLAG_PINNED | FLAG_DRAGGING)) continue;
      e += 0.5 * g.mass[i]! * (g.vx[i]! * g.vx[i]! + g.vy[i]! * g.vy[i]!);
    }
    return e;
  }

  /** Bounding box of the visible nodes, or `null` if nothing is visible. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const g = this.graph;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let any = false;
    for (let i = 0; i < g.nodeCount; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      const r = g.radius[i]!;
      if (g.x[i]! - r < minX) minX = g.x[i]! - r;
      if (g.x[i]! + r > maxX) maxX = g.x[i]! + r;
      if (g.y[i]! - r < minY) minY = g.y[i]! - r;
      if (g.y[i]! + r > maxY) maxY = g.y[i]! + r;
      any = true;
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  on(event: 'tick' | 'end', fn: Listener): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }

  off(event: 'tick' | 'end', fn: Listener): this {
    const l = this.listeners[event];
    if (l) {
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
    return this;
  }

  private emit(event: string): void {
    const l = this.listeners[event];
    if (!l) return;
    for (const fn of l) fn(this);
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
