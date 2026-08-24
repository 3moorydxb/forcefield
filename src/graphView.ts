import { Graph, FLAG_SELECTED, type GraphData, type NodeSpec, type LinkSpec } from './core/graph.js';
import { Simulation, type SimulationConfig } from './core/simulation.js';
import { applyFilter, type Filter, type FilterStats } from './core/filter.js';
import type { PhysicsSettings } from './core/physics.js';
import { Camera } from './render/camera.js';
import { Canvas2DRenderer, type Canvas2DOptions } from './render/canvas2d.js';
import type { Renderer, RenderFrame } from './render/renderer.js';
import { darkTheme, TypePalette, type Theme } from './render/theme.js';
import { InteractionController, type ControllerOptions } from './interaction/controller.js';
import { FpsMeter, type FrameStats } from './util/fps.js';

export interface GraphViewOptions {
  container: HTMLElement;
  theme?: Theme;
  simulation?: SimulationConfig;
  controller?: ControllerOptions;
  canvas?: Canvas2DOptions;
  /** Swap in a different renderer. Given the canvas the view creates. */
  makeRenderer?: (canvas: HTMLCanvasElement) => Renderer;
  /** Simulation ticks per animation frame. >1 settles faster, costs proportionally. */
  ticksPerFrame?: number;
  /** Cap on device pixel ratio. 3× on a Retina display triples the fill cost. */
  maxDpr?: number;
  autoResize?: boolean;
}

/**
 * Everything wired together: graph + simulation + renderer + interaction + a
 * requestAnimationFrame loop.
 *
 * Optional by design — `Simulation` and `Canvas2DRenderer` are usable on their
 * own, and a consumer that already owns its render loop should use them
 * directly. This class exists so the common case is four lines.
 */
export class GraphView {
  readonly graph: Graph;
  readonly simulation: Simulation;
  readonly camera = new Camera();
  readonly renderer: Renderer;
  readonly controller: InteractionController;
  readonly palette = new TypePalette();
  readonly canvas: HTMLCanvasElement;
  readonly meter = new FpsMeter();

  ticksPerFrame: number;
  /**
   * When to redraw.
   *
   * `'on-change'` (the default) skips the draw entirely on frames where nothing
   * moved — no tick, no camera change, no hover change, no structural change,
   * nothing selected. A settled graph sitting on screen then costs essentially
   * zero, which matters more than it sounds: Canvas 2D rasterisation is the
   * dominant cost of a large graph, and on a machine without GPU acceleration it
   * is the ONLY cost that matters. Measured here: 1,651 nodes redrawing every
   * frame on a software rasteriser held ~51fps with the physics switched off.
   *
   * `'always'` redraws unconditionally — use it when something outside the
   * engine animates the frame, or when benchmarking.
   */
  redrawPolicy: 'on-change' | 'always' = 'on-change';

  private container: HTMLElement;
  private raf = 0;
  private running = false;
  private maxDpr: number;
  private dim: Uint8Array | null = null;
  private observer: ResizeObserver | null = null;
  private dirty = true;
  private lastDrawn = { cx: NaN, cy: NaN, ck: NaN, hover: '\u0000', version: -1, marquee: false };
  private _theme: Theme;

  /** Swapping the theme marks the frame dirty, so a themed redraw is never missed. */
  get theme(): Theme {
    return this._theme;
  }
  set theme(t: Theme) {
    this._theme = t;
    this.dirty = true;
  }

  constructor(opts: GraphViewOptions) {
    this.container = opts.container;
    this._theme = opts.theme ?? darkTheme;
    this.ticksPerFrame = opts.ticksPerFrame ?? 1;
    this.maxDpr = opts.maxDpr ?? 2;

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    this.container.appendChild(this.canvas);

    this.graph = new Graph();
    this.simulation = new Simulation(this.graph, opts.simulation);
    this.renderer = opts.makeRenderer
      ? opts.makeRenderer(this.canvas)
      : new Canvas2DRenderer(this.canvas, opts.canvas);
    this.controller = new InteractionController(
      this.canvas,
      this.simulation,
      this.camera,
      opts.controller,
    );

    this.resize();
    if (opts.autoResize ?? true) {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.container);
    }
  }

  // ------------------------------------------------------------------ data

  /** Replace the graph's contents. Assigns palette slots over the whole set. */
  load(data: GraphData, opts: { fit?: boolean; alpha?: number } = {}): void {
    for (const n of data.nodes) this.graph.addNode(n);
    let skipped = 0;
    for (const l of data.links) {
      if (!this.graph.has(l.source) || !this.graph.has(l.target)) {
        skipped++;
        continue;
      }
      this.graph.addLink(l);
    }
    if (skipped > 0) {
      // Reported, not swallowed. A link to a node that is not in the file is a
      // hole in the data, and a silently dropped edge looks like a real gap in
      // the structure.
      console.warn(`forcefield: ${skipped} link(s) named a node not present in the data`);
    }
    this.palette.assignFrom(this.graph);
    this.simulation.restart(opts.alpha ?? 1);
    this.dirty = true;
    if (opts.fit ?? true) this.fit();
  }

  /**
   * Insert a node into the RUNNING simulation, with its links.
   *
   * This is the streaming case: a new node arrives and has to appear and settle
   * without the rest of the graph jumping. It reheats
   * rather than restarting, and seeds the new node beside whatever it connects
   * to so it does not have to travel across the whole layout to get there.
   */
  insert(node: NodeSpec, links: LinkSpec[] = [], reheat = 0.3): void {
    const isNew = !this.graph.has(node.id);
    this.graph.addNode(node);
    for (const l of links) {
      if (this.graph.has(l.source) && this.graph.has(l.target)) this.graph.addLink(l);
    }
    if (isNew && node.x === undefined && node.y === undefined) {
      this.graph.seedNearNeighbours(node.id);
    }
    // A new type must not repaint the existing ones, so slots are re-derived
    // from the whole graph — assignment is by frequency over everything, and an
    // established type keeps its slot.
    this.palette.assignFrom(this.graph);
    this.simulation.reheat(reheat);
    this.dirty = true;
  }

  // --------------------------------------------------------------- display

  /**
   * Hide everything the filter excludes. Positions are preserved and the
   * simulation is NOT restarted — clearing the filter puts every node back
   * exactly where it was.
   */
  filter(f: Filter | null, opts: { reheat?: number } = {}): FilterStats {
    const stats = applyFilter(this.graph, f);
    this.dirty = true;
    if (opts.reheat) this.simulation.reheat(opts.reheat);
    return stats;
  }

  /**
   * Dim everything the filter excludes, rather than removing it.
   *
   * The difference from `filter` is physical: a dimmed node is still in the
   * simulation and still on screen, just recessive. Use this to answer "where
   * does this branch sit in the whole thing", and `filter` to answer "show me
   * only this branch".
   */
  highlight(f: Filter | null): void {
    this.dim = f ? f.resolve(this.graph) : null;
    this.dirty = true;
  }

  /**
   * Change physics live. Marks the frame dirty so a settled graph redraws even
   * though `redrawPolicy` is `'on-change'` — without this the numbers change and
   * the screen does not.
   */
  setForces(patch: Partial<PhysicsSettings>, opts: { reheat?: number } = {}): this {
    this.simulation.setForces(patch, opts);
    this.dirty = true;
    return this;
  }

  getForces(): PhysicsSettings {
    return this.simulation.getForces();
  }

  fit(padding = 56): void {
    const b = this.simulation.bounds();
    if (b) this.camera.fit(b, padding);
    this.dirty = true;
  }

  /**
   * Fit once, the next time the simulation settles.
   *
   * Fitting at load time frames the graph as it was *before* any physics ran —
   * which on a fresh layout is a tight knot near the origin that then expands
   * off screen. This waits for the arrangement to exist before framing it.
   */
  fitWhenSettled(padding = 56): void {
    const once = (): void => {
      this.simulation.off('end', once);
      this.fit(padding);
    };
    this.simulation.on('end', once);
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(this.maxDpr, globalThis.devicePixelRatio || 1);
    this.camera.setViewport(w, h);
    this.renderer.resize(w, h, dpr);
    this.dirty = true;
  }

  // ------------------------------------------------------------------ loop

  start(): this {
    if (this.running) return this;
    this.running = true;
    const loop = (t: number): void => {
      if (!this.running) return;
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return this;
  }

  stop(): this {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    return this;
  }

  /** Force a redraw on the next frame — for anything the view cannot observe. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * Has anything changed since the last draw?
   *
   * Anything the view can observe on its own is checked here rather than relying
   * on every caller to remember to invalidate — a missed invalidation shows up
   * as a frozen screen, which is a much worse failure than a redundant draw.
   */
  private needsRedraw(): boolean {
    if (this.redrawPolicy === 'always' || this.dirty) return true;
    // The renderer may own an animation the simulation cannot see — a pulsing
    // ring, marching dashes, a consumer decoration. Freezing those the instant
    // the graph settles is a silent, baffling failure.
    if (this.renderer.animating) return true;
    const c = this.camera;
    const l = this.lastDrawn;
    if (c.x !== l.cx || c.y !== l.cy || c.k !== l.ck) return true;
    if ((this.controller.hover ?? '') !== l.hover) return true;
    if (this.graph.version !== l.version) return true;
    if (!!this.controller.marquee !== l.marquee) return true;
    if (this.controller.marquee) return true;
    // A selection ring pulses, so a selected node means a live animation.
    for (let i = 0; i < this.graph.nodeCount; i++) {
      if (this.graph.flags[i]! & FLAG_SELECTED) return true;
    }
    return false;
  }

  /** One frame, run manually. Exposed so a benchmark can drive the loop itself. */
  frame(timeMs: number): void {
    const t0 = performance.now();
    if (!this.simulation.settled || this.simulation.alphaTarget > this.simulation.alphaMin) {
      this.simulation.tick(this.ticksPerFrame);
      this.dirty = true;
    }
    const t1 = performance.now();

    if (!this.needsRedraw()) {
      this.meter.frame(t0, t1 - t0, 0);
      return;
    }

    const frame: RenderFrame = {
      graph: this.graph,
      camera: this.camera,
      theme: this.theme,
      palette: this.palette,
      hover: this.controller.hover,
      dim: this.dim,
      marquee: this.controller.marquee,
      timeMs,
      tree: this.simulation.tree,
    };
    this.renderer.render(frame);
    const t2 = performance.now();

    this.dirty = false;
    this.lastDrawn.cx = this.camera.x;
    this.lastDrawn.cy = this.camera.y;
    this.lastDrawn.ck = this.camera.k;
    this.lastDrawn.hover = this.controller.hover ?? '';
    this.lastDrawn.version = this.graph.version;
    this.lastDrawn.marquee = !!this.controller.marquee;

    this.meter.frame(t0, t1 - t0, t2 - t1);
  }

  stats(): FrameStats {
    return this.meter.stats();
  }

  destroy(): void {
    this.stop();
    this.observer?.disconnect();
    this.controller.destroy();
    this.renderer.destroy();
    this.canvas.remove();
  }
}
