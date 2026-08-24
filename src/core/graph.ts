import { Rng } from '../util/rng.js';

/**
 * The graph.
 *
 * Hot per-node state (position, velocity, acceleration, radius, mass, flags)
 * lives in parallel typed arrays so the force loops walk contiguous memory.
 * Cold per-node state (id, type, label, consumer payload) lives in plain arrays
 * at the same index.
 *
 * The public API is **id-based**. Indices are an internal detail that changes
 * whenever a node is removed (removal is a swap with the last slot), so nothing
 * outside this class should hold an index across a structural change. Selection
 * and pinning are stored in the flags array precisely so they survive that swap.
 *
 * The engine never interprets `type`, `label` or `data`. They exist so a
 * consumer can colour, filter and route by its own vocabulary without the
 * engine learning that vocabulary.
 */

export const FLAG_PINNED = 1;
export const FLAG_HIDDEN = 2;
export const FLAG_SELECTED = 4;
export const FLAG_DRAGGING = 8;

export interface NodeSpec {
  id: string;
  /** Consumer's own category string. Never interpreted here. */
  type?: string;
  label?: string;
  /** Consumer payload. Never read here. */
  data?: unknown;
  x?: number;
  y?: number;
  /** Drawing + collision radius, world units. Must be > 0. */
  radius?: number;
  /** Inertia. Heavier nodes move less for the same force. Must be > 0. */
  mass?: number;
  /** Repulsion charge. Negative repels (the default), positive attracts. */
  charge?: number;
  pinned?: boolean;
}

export interface LinkSpec {
  source: string;
  target: string;
  /**
   * Confidence / strength in `[0, 1]`. Scales the spring and, if the renderer
   * wants it, the stroke. A graded graph uses it as a confidence or relevance
   * score; a strict tree can leave it at 1.
   */
  weight?: number;
  /** Preferred rest length in world units. Falls back to the link force default. */
  distance?: number;
  /** Consumer's own edge category. Never interpreted here. */
  kind?: string;
  data?: unknown;
}

export interface NodeView {
  index: number;
  id: string;
  type: string;
  label: string;
  data: unknown;
  x: number;
  y: number;
  radius: number;
  degree: number;
  pinned: boolean;
  hidden: boolean;
  selected: boolean;
}

const INITIAL_CAPACITY = 64;

export class Graph {
  // --- cold, per node -----------------------------------------------------
  readonly ids: string[] = [];
  readonly types: string[] = [];
  readonly labels: string[] = [];
  readonly payload: unknown[] = [];

  // --- hot, per node ------------------------------------------------------
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** Acceleration carried between ticks — velocity-Verlet needs the previous one. */
  ax: Float64Array;
  ay: Float64Array;
  radius: Float64Array;
  mass: Float64Array;
  charge: Float64Array;
  flags: Uint8Array;
  degree: Uint32Array;

  // --- links --------------------------------------------------------------
  linkSource: Uint32Array;
  linkTarget: Uint32Array;
  linkWeight: Float64Array;
  linkDistance: Float64Array;
  readonly linkKinds: string[] = [];
  readonly linkPayload: unknown[] = [];

  private _nodeCount = 0;
  private _linkCount = 0;
  private _nodeCapacity = INITIAL_CAPACITY;
  private _linkCapacity = INITIAL_CAPACITY;
  private readonly indexById = new Map<string, number>();
  private readonly linkKeys = new Set<string>();

  /** Bumped on every structural change (add/remove). Consumers may cache against it. */
  version = 0;

  private readonly rng: Rng;
  /** CSR adjacency, rebuilt lazily. */
  private adjOffset: Uint32Array | null = null;
  private adjNeighbour: Uint32Array | null = null;
  private adjVersion = -1;

  constructor(seed = 0x9e3779b9) {
    this.rng = new Rng(seed);
    this.x = new Float64Array(INITIAL_CAPACITY);
    this.y = new Float64Array(INITIAL_CAPACITY);
    this.vx = new Float64Array(INITIAL_CAPACITY);
    this.vy = new Float64Array(INITIAL_CAPACITY);
    this.ax = new Float64Array(INITIAL_CAPACITY);
    this.ay = new Float64Array(INITIAL_CAPACITY);
    this.radius = new Float64Array(INITIAL_CAPACITY);
    this.mass = new Float64Array(INITIAL_CAPACITY);
    this.charge = new Float64Array(INITIAL_CAPACITY);
    this.flags = new Uint8Array(INITIAL_CAPACITY);
    this.degree = new Uint32Array(INITIAL_CAPACITY);
    this.linkSource = new Uint32Array(INITIAL_CAPACITY);
    this.linkTarget = new Uint32Array(INITIAL_CAPACITY);
    this.linkWeight = new Float64Array(INITIAL_CAPACITY);
    this.linkDistance = new Float64Array(INITIAL_CAPACITY);
  }

  get nodeCount(): number {
    return this._nodeCount;
  }
  get linkCount(): number {
    return this._linkCount;
  }

  indexOf(id: string): number {
    const i = this.indexById.get(id);
    return i === undefined ? -1 : i;
  }
  has(id: string): boolean {
    return this.indexById.has(id);
  }

  // ------------------------------------------------------------------ nodes

  /**
   * Add a node. Safe to call while the simulation is running — this is the
   * streaming case, where nodes arrive one at a time from a running source.
   *
   * A node with no given position is placed near its already-present neighbours
   * if it has any, otherwise on a small disc around the origin. Dropping a new
   * node at exactly (0,0) next to every other new node produces a singularity
   * the repulsion step then has to explode its way out of.
   */
  addNode(spec: NodeSpec): number {
    const existing = this.indexById.get(spec.id);
    if (existing !== undefined) return existing;

    if (this._nodeCount === this._nodeCapacity) this.growNodes();
    const i = this._nodeCount++;

    this.ids[i] = spec.id;
    this.types[i] = spec.type ?? '';
    this.labels[i] = spec.label ?? spec.id;
    this.payload[i] = spec.data ?? null;
    this.indexById.set(spec.id, i);

    const seed = this.rng.discPoint(30);
    this.x[i] = spec.x ?? seed.x;
    this.y[i] = spec.y ?? seed.y;
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.ax[i] = 0;
    this.ay[i] = 0;
    this.radius[i] = positive(spec.radius, 4, 'radius');
    this.mass[i] = positive(spec.mass, 1, 'mass');
    this.charge[i] = spec.charge ?? -30;
    this.flags[i] = spec.pinned ? FLAG_PINNED : 0;
    this.degree[i] = 0;

    this.version++;
    this.adjVersion = -1;
    return i;
  }

  /**
   * Place a node that has no explicit position near the mean of the neighbours
   * it already has. Call after adding its links; the engine's `GraphView` does
   * this for you on live insertion.
   */
  seedNearNeighbours(id: string, jitter = 12): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let l = 0; l < this._linkCount; l++) {
      const s = this.linkSource[l]!;
      const t = this.linkTarget[l]!;
      let other = -1;
      if (s === i) other = t;
      else if (t === i) other = s;
      if (other < 0) continue;
      sx += this.x[other]!;
      sy += this.y[other]!;
      n++;
    }
    if (n === 0) return;
    const j = this.rng.discPoint(jitter);
    this.x[i] = sx / n + j.x;
    this.y[i] = sy / n + j.y;
    this.vx[i] = 0;
    this.vy[i] = 0;
  }

  /**
   * Remove a node and every link touching it.
   *
   * Implemented as a swap with the last slot, so this is O(links) rather than
   * O(nodes + links) — but it means the index of the previously-last node
   * changes. That is why nothing outside this class holds an index.
   */
  removeNode(id: string): boolean {
    const i = this.indexById.get(id);
    if (i === undefined) return false;
    const last = this._nodeCount - 1;

    // 1. drop links touching i, and re-point links that referenced `last`.
    let w = 0;
    for (let r = 0; r < this._linkCount; r++) {
      const s = this.linkSource[r]!;
      const t = this.linkTarget[r]!;
      if (s === i || t === i) {
        this.linkKeys.delete(linkKey(this.ids[s]!, this.ids[t]!));
        continue;
      }
      this.linkSource[w] = s === last ? i : s;
      this.linkTarget[w] = t === last ? i : t;
      this.linkWeight[w] = this.linkWeight[r]!;
      this.linkDistance[w] = this.linkDistance[r]!;
      this.linkKinds[w] = this.linkKinds[r]!;
      this.linkPayload[w] = this.linkPayload[r];
      w++;
    }
    this._linkCount = w;
    this.linkKinds.length = w;
    this.linkPayload.length = w;

    // 2. swap the last node into i.
    this.indexById.delete(id);
    if (i !== last) {
      this.ids[i] = this.ids[last]!;
      this.types[i] = this.types[last]!;
      this.labels[i] = this.labels[last]!;
      this.payload[i] = this.payload[last];
      this.x[i] = this.x[last]!;
      this.y[i] = this.y[last]!;
      this.vx[i] = this.vx[last]!;
      this.vy[i] = this.vy[last]!;
      this.ax[i] = this.ax[last]!;
      this.ay[i] = this.ay[last]!;
      this.radius[i] = this.radius[last]!;
      this.mass[i] = this.mass[last]!;
      this.charge[i] = this.charge[last]!;
      this.flags[i] = this.flags[last]!;
      this.indexById.set(this.ids[i]!, i);
    }
    this.ids.length = last;
    this.types.length = last;
    this.labels.length = last;
    this.payload.length = last;
    this._nodeCount = last;

    this.version++;
    this.adjVersion = -1;
    this.recomputeDegrees();
    return true;
  }

  // ------------------------------------------------------------------ links

  /**
   * Add a link. Endpoints must already exist — a link to a node that is not
   * there is a data bug in the caller, and silently creating a phantom node
   * would hide it.
   */
  addLink(spec: LinkSpec): number {
    const s = this.indexById.get(spec.source);
    const t = this.indexById.get(spec.target);
    if (s === undefined) throw new Error(`addLink: unknown source node ${JSON.stringify(spec.source)}`);
    if (t === undefined) throw new Error(`addLink: unknown target node ${JSON.stringify(spec.target)}`);
    if (s === t) return -1; // self-loops have no force meaning here

    const key = linkKey(spec.source, spec.target);
    if (this.linkKeys.has(key)) return -1;

    if (this._linkCount === this._linkCapacity) this.growLinks();
    const l = this._linkCount++;
    this.linkSource[l] = s;
    this.linkTarget[l] = t;
    this.linkWeight[l] = clamp01(spec.weight ?? 1);
    this.linkDistance[l] = spec.distance !== undefined ? positive(spec.distance, 0, 'distance') : 0;
    this.linkKinds[l] = spec.kind ?? '';
    this.linkPayload[l] = spec.data ?? null;
    this.linkKeys.add(key);

    this.degree[s]!++;
    this.degree[t]!++;
    this.version++;
    this.adjVersion = -1;
    return l;
  }

  private recomputeDegrees(): void {
    this.degree.fill(0, 0, this._nodeCount);
    for (let l = 0; l < this._linkCount; l++) {
      this.degree[this.linkSource[l]!]!++;
      this.degree[this.linkTarget[l]!]!++;
    }
  }

  // ------------------------------------------------------------------ flags

  isPinned(id: string): boolean {
    return this.hasFlag(id, FLAG_PINNED);
  }
  isHidden(id: string): boolean {
    return this.hasFlag(id, FLAG_HIDDEN);
  }
  isSelected(id: string): boolean {
    return this.hasFlag(id, FLAG_SELECTED);
  }

  private hasFlag(id: string, f: number): boolean {
    const i = this.indexById.get(id);
    return i !== undefined && (this.flags[i]! & f) !== 0;
  }

  /**
   * Pin or unpin. A pinned node does not integrate — but it stays in the
   * quadtree and stays on both ends of its springs, so it goes on pushing and
   * pulling everything around it. That is the whole point of pinning: you nail
   * one thing down and let the rest arrange themselves around it.
   */
  setPinned(id: string, pinned: boolean): void {
    const i = this.indexById.get(id);
    if (i === undefined) return;
    if (pinned) {
      this.flags[i]! |= FLAG_PINNED;
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.ax[i] = 0;
      this.ay[i] = 0;
    } else {
      this.flags[i]! &= ~FLAG_PINNED;
    }
  }

  setSelected(id: string, selected: boolean): void {
    const i = this.indexById.get(id);
    if (i === undefined) return;
    if (selected) this.flags[i]! |= FLAG_SELECTED;
    else this.flags[i]! &= ~FLAG_SELECTED;
  }

  clearSelection(): void {
    for (let i = 0; i < this._nodeCount; i++) this.flags[i]! &= ~FLAG_SELECTED;
  }

  selectedIds(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this._nodeCount; i++) {
      if (this.flags[i]! & FLAG_SELECTED) out.push(this.ids[i]!);
    }
    return out;
  }

  /**
   * Hide or show. Hidden nodes are excluded from every force and from the
   * renderer, and are NOT integrated — so their coordinates are frozen exactly
   * where they were. Unhiding restores them to that spot rather than dropping
   * them at the origin, which is what makes filtering reversible.
   */
  setHidden(id: string, hidden: boolean): void {
    const i = this.indexById.get(id);
    if (i === undefined) return;
    if (hidden) {
      this.flags[i]! |= FLAG_HIDDEN;
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.ax[i] = 0;
      this.ay[i] = 0;
    } else {
      this.flags[i]! &= ~FLAG_HIDDEN;
    }
  }

  setPosition(id: string, x: number, y: number): void {
    const i = this.indexById.get(id);
    if (i === undefined) return;
    this.x[i] = x;
    this.y[i] = y;
  }

  node(id: string): NodeView | null {
    const i = this.indexById.get(id);
    return i === undefined ? null : this.viewAt(i);
  }

  viewAt(i: number): NodeView {
    const f = this.flags[i]!;
    return {
      index: i,
      id: this.ids[i]!,
      type: this.types[i]!,
      label: this.labels[i]!,
      data: this.payload[i],
      x: this.x[i]!,
      y: this.y[i]!,
      radius: this.radius[i]!,
      degree: this.degree[i]!,
      pinned: (f & FLAG_PINNED) !== 0,
      hidden: (f & FLAG_HIDDEN) !== 0,
      selected: (f & FLAG_SELECTED) !== 0,
    };
  }

  // -------------------------------------------------------------- adjacency

  /** CSR adjacency over the *whole* graph (hidden nodes included). */
  adjacency(): { offset: Uint32Array; neighbour: Uint32Array } {
    if (this.adjVersion === this.version && this.adjOffset && this.adjNeighbour) {
      return { offset: this.adjOffset, neighbour: this.adjNeighbour };
    }
    const n = this._nodeCount;
    const offset = new Uint32Array(n + 1);
    for (let l = 0; l < this._linkCount; l++) {
      offset[this.linkSource[l]! + 1]!++;
      offset[this.linkTarget[l]! + 1]!++;
    }
    for (let i = 0; i < n; i++) offset[i + 1]! += offset[i]!;
    const neighbour = new Uint32Array(this._linkCount * 2);
    const cursor = Uint32Array.from(offset.subarray(0, n));
    for (let l = 0; l < this._linkCount; l++) {
      const s = this.linkSource[l]!;
      const t = this.linkTarget[l]!;
      neighbour[cursor[s]!++] = t;
      neighbour[cursor[t]!++] = s;
    }
    this.adjOffset = offset;
    this.adjNeighbour = neighbour;
    this.adjVersion = this.version;
    return { offset, neighbour };
  }

  /** Directed children of `i` (links where `i` is the source). */
  childrenOf(i: number, out: number[] = []): number[] {
    out.length = 0;
    for (let l = 0; l < this._linkCount; l++) {
      if (this.linkSource[l]! === i) out.push(this.linkTarget[l]!);
    }
    return out;
  }

  // ------------------------------------------------------------------ bulk

  /** Load a plain-JSON graph. See `GraphData` for the shape. */
  static from(data: GraphData, seed?: number): Graph {
    const g = new Graph(seed);
    for (const n of data.nodes) g.addNode(n);
    for (const l of data.links) {
      // A link naming a node that is not in the file is reported, not invented.
      if (!g.has(l.source) || !g.has(l.target)) continue;
      g.addLink(l);
    }
    return g;
  }

  toJSON(): GraphData {
    const nodes: NodeSpec[] = [];
    for (let i = 0; i < this._nodeCount; i++) {
      nodes.push({
        id: this.ids[i]!,
        type: this.types[i]!,
        label: this.labels[i]!,
        x: this.x[i]!,
        y: this.y[i]!,
        radius: this.radius[i]!,
        pinned: (this.flags[i]! & FLAG_PINNED) !== 0,
      });
    }
    const links: LinkSpec[] = [];
    for (let l = 0; l < this._linkCount; l++) {
      links.push({
        source: this.ids[this.linkSource[l]!]!,
        target: this.ids[this.linkTarget[l]!]!,
        weight: this.linkWeight[l]!,
        kind: this.linkKinds[l]!,
      });
    }
    return { nodes, links };
  }

  // ----------------------------------------------------------------- growth

  private growNodes(): void {
    const cap = this._nodeCapacity * 2;
    this.x = grow64(this.x, cap);
    this.y = grow64(this.y, cap);
    this.vx = grow64(this.vx, cap);
    this.vy = grow64(this.vy, cap);
    this.ax = grow64(this.ax, cap);
    this.ay = grow64(this.ay, cap);
    this.radius = grow64(this.radius, cap);
    this.mass = grow64(this.mass, cap);
    this.charge = grow64(this.charge, cap);
    const f = new Uint8Array(cap);
    f.set(this.flags);
    this.flags = f;
    const d = new Uint32Array(cap);
    d.set(this.degree);
    this.degree = d;
    this._nodeCapacity = cap;
  }

  private growLinks(): void {
    const cap = this._linkCapacity * 2;
    const s = new Uint32Array(cap);
    s.set(this.linkSource);
    this.linkSource = s;
    const t = new Uint32Array(cap);
    t.set(this.linkTarget);
    this.linkTarget = t;
    this.linkWeight = grow64(this.linkWeight, cap);
    this.linkDistance = grow64(this.linkDistance, cap);
    this._linkCapacity = cap;
  }
}

export interface GraphData {
  nodes: NodeSpec[];
  links: LinkSpec[];
}

function grow64(src: Float64Array, cap: number): Float64Array {
  const a = new Float64Array(cap);
  a.set(src);
  return a;
}

function linkKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A magnitude must be positive. This is the same rule as `assertAnimation` in
 * `direction.ts`: a negative radius or mass is a caller bug, and quietly taking
 * its absolute value or clamping it to zero produces a graph that renders but
 * is wrong.
 */
function positive(v: number | undefined, fallback: number, what: string): number {
  if (v === undefined) return fallback;
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`${what} must be a finite number > 0, received ${String(v)}`);
  }
  return v;
}
