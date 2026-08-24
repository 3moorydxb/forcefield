import type { Renderer, RenderFrame, RenderStats } from './renderer.js';
import { FLAG_HIDDEN, FLAG_PINNED, FLAG_SELECTED } from '../core/graph.js';
import { animationPhase, type AnimationSpec } from '../core/direction.js';
import type { Graph } from '../core/graph.js';
import type { NodeShape } from './theme.js';

export interface Canvas2DOptions {
  /**
   * Zoom above which labels appear at all. Below it, labels are illegible and
   * cost more than the graph itself.
   */
  labelZoom?: number;
  /**
   * Hard cap on labels per frame. Text is by far the most expensive thing a
   * canvas draws: 2,800 labels is roughly 2,800 shaping passes. Nodes are
   * chosen by degree, so the cap keeps the ones that carry the structure.
   */
  maxLabels?: number;
  /** Number of distinct stroke widths used for link weight. More = less batching. */
  weightBuckets?: number;
  /**
   * Smallest a node may be drawn, in screen pixels.
   *
   * Every ring (pin, hover, selection) is measured OUT FROM this same number, so
   * a node and its decoration stay in proportion at any zoom. Sizing the fill in
   * world units while flooring the rings in screen pixels makes a zoomed-out
   * graph render as hollow circles — the ring keeps its size while the disc
   * inside it shrinks to nothing.
   */
  minNodePx?: number;
  font?: string;
  /** Pulse on the selection ring. Direction is a field, never a negative duration. */
  selectionPulse?: AnimationSpec;
  /** Draw the debug quadtree overlay. */
  showQuadtree?: boolean;

  /** Where a label sits relative to its node. */
  labelPlacement?: 'right' | 'below';

  /**
   * Whether `decorate` draws something that changes over time.
   *
   * Defaults to `true` whenever a `decorate` hook is supplied, and that default
   * is deliberately the SAFE one: the engine cannot inspect a consumer's
   * callback, and the failure mode of guessing wrong is a pulse that silently
   * stops the moment the graph settles. Set it to `false` for a static
   * decoration to get the idle-costs-nothing behaviour back.
   */
  decorateAnimates?: boolean;

  /**
   * Classify a node into a `theme.nodeStyles` bucket. Return `-1` to fall back
   * to the categorical palette.
   *
   * Called once per visible node per frame, so keep it cheap — an index lookup,
   * not an object allocation. Returning an index rather than a style is what
   * preserves batching.
   */
  styleNode?: (i: number, graph: Graph) => number;
  /** Same, for links, into `theme.linkStyles`. */
  styleLink?: (l: number, graph: Graph) => number;

  /**
   * Draw extra per-node channels after the nodes are filled.
   *
   * The escape hatch that keeps consumer meaning OUT of the engine: a status
   * glyph, a promotion tick, a pulsing ring for something the user declared
   * rather than discovered. The engine hands over a context already in screen
   * space and never asks what any of it means.
   *
   * Runs only for visible, non-culled nodes. Leave the context as you found it.
   */
  decorate?: (ctx: CanvasRenderingContext2D, i: number, frame: DecorationInfo) => void;

  /**
   * Marching-ants animation for any link style with `animateDash`.
   *
   * Direction is a FIELD here, never the sign of the dash offset — the whole
   * reason `core/direction.ts` exists. `'reverse'` makes the ants crawl the
   * other way at the same speed.
   */
  dashAnimation?: AnimationSpec;
}

/** What `decorate` is handed for one node. Screen-space, ready to draw. */
export interface DecorationInfo {
  graph: Graph;
  /** Node centre, screen pixels. */
  x: number;
  y: number;
  /** On-screen radius, already floored to `minNodePx`. */
  r: number;
  /** `true` when the node is recessive in dim mode. */
  dimmed: boolean;
  selected: boolean;
  hovered: boolean;
  timeMs: number;
}

/**
 * Canvas 2D renderer.
 *
 * The whole performance story here is **batching**. A canvas call like
 * `strokeStyle = …` forces the driver to flush; done per edge, 6,000 edges cost
 * 6,000 state changes and the frame is gone before any physics runs. So every
 * edge that shares a style goes into ONE path and is stroked once, and every
 * node that shares a fill goes into one path and is filled once. That turns
 * thousands of state changes into about twenty.
 *
 * The other half is refusing to draw what cannot be seen: off-screen nodes are
 * culled against the camera's world bounds, and labels are capped and gated on
 * zoom.
 *
 * It is Canvas 2D and not WebGL because at the scale this was built for
 * (single-digit thousands of nodes) Canvas holds 60fps with room to spare, and
 * it has no shader compilation, no context-loss handling, and no dependency.
 * When a consumer needs 100k nodes, `Renderer` is the seam to replace — nothing
 * else has to change.
 */
export class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d';
  readonly stats: RenderStats = { nodesDrawn: 0, linksDrawn: 0, labelsDrawn: 0 };

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssWidth = 1;
  private cssHeight = 1;

  private readonly labelZoom: number;
  private readonly maxLabels: number;
  private readonly weightBuckets: number;
  private readonly minNodePx: number;
  private readonly font: string;
  private readonly pulse: AnimationSpec;
  private readonly dashAnim: AnimationSpec;
  private readonly styleNode: ((i: number, g: Graph) => number) | undefined;
  private readonly styleLink: ((l: number, g: Graph) => number) | undefined;
  private readonly decorate:
    | ((ctx: CanvasRenderingContext2D, i: number, frame: DecorationInfo) => void)
    | undefined;
  showQuadtree: boolean;

  /**
   * Did the LAST frame contain something that animates?
   *
   * `GraphView.needsRedraw()` reads this. Without it, `redrawPolicy:
   * 'on-change'` stops drawing the instant the simulation settles, and any
   * animation the renderer owns — a selection pulse, marching-ant dashes, a
   * consumer's decoration — freezes mid-cycle with nothing to say why.
   */
  animating = false;

  private readonly labelPlacement: 'right' | 'below';
  private readonly decorateAnimates: boolean;

  // Reused per frame so the frame loop allocates nothing.
  private nodeBuckets: number[][] = [];
  private linkBuckets: number[][] = [];
  private activeLinks: number[] = [];
  private labelCandidates: number[] = [];

  constructor(canvas: HTMLCanvasElement, opts: Canvas2DOptions = {}) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas2DRenderer: could not acquire a 2d context');
    this.canvas = canvas;
    this.ctx = ctx;
    this.labelZoom = opts.labelZoom ?? 0.55;
    this.maxLabels = opts.maxLabels ?? 180;
    this.weightBuckets = Math.max(1, opts.weightBuckets ?? 3);
    this.minNodePx = opts.minNodePx ?? 1.6;
    this.font = opts.font ?? '11px ui-sans-serif, system-ui, -apple-system, sans-serif';
    this.showQuadtree = opts.showQuadtree ?? false;

    // The trap this engine refuses to fall into: a reversed animation is
    // `direction: 'reverse'`, never `durationMs: -2400`. A negative duration is
    // clamped to zero by CSS and rejected outright here, and a clamped animation
    // looks exactly like one that was never written.
    this.pulse = opts.selectionPulse ?? { durationMs: 2400, direction: 'forward' };
    this.dashAnim = opts.dashAnimation ?? { durationMs: 550, direction: 'forward' };
    this.styleNode = opts.styleNode;
    this.styleLink = opts.styleLink;
    this.decorate = opts.decorate;
    this.labelPlacement = opts.labelPlacement ?? 'right';
    this.decorateAnimates = opts.decorateAnimates ?? opts.decorate !== undefined;
  }

  /**
   * Trace one node shape into the CURRENT path. Never begins or fills a path —
   * the caller batches many of these between one `beginPath` and one `fill`.
   */
  private tracePath(
    ctx: CanvasRenderingContext2D,
    shape: NodeShape,
    x: number,
    y: number,
    r: number,
  ): void {
    switch (shape) {
      case 'square':
        ctx.rect(x - r * 0.86, y - r * 0.86, r * 1.72, r * 1.72);
        return;
      case 'diamond':
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
        return;
      case 'triangle':
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r * 0.87, y + r * 0.5);
        ctx.lineTo(x - r * 0.87, y + r * 0.5);
        ctx.closePath();
        return;
      case 'hexagon': {
        // Pointy-top: the first vertex sits straight up.
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k - Math.PI / 2;
          const px = x + Math.cos(a) * r;
          const py = y + Math.sin(a) * r;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        return;
      }
      case 'square-in-square':
        // Two clockwise rects. Under the default nonzero fill rule the inner
        // square fills solid; `evenodd` would knock it out into a ring, which is
        // a different symbol. Do not change the fill rule.
        ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
        ctx.rect(x - r * 0.42, y - r * 0.42, r * 0.84, r * 0.84);
        return;
      case 'circle':
      default:
        // moveTo before arc, or consecutive arcs are joined by a chord.
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
    }
  }

  /** The one place a node's on-screen size is decided. Rings measure out from it. */
  private screenRadius(worldRadius: number, k: number): number {
    const r = worldRadius * k;
    return r < this.minNodePx ? this.minNodePx : r;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
  }

  render(frame: RenderFrame): void {
    const { graph: g, camera, theme, palette, dim } = frame;
    const ctx = this.ctx;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    let animating = false;
    const stats = this.stats;
    stats.nodesDrawn = 0;
    stats.linksDrawn = 0;
    stats.labelsDrawn = 0;

    const n = g.nodeCount;
    if (n === 0) return;

    const k = camera.k;
    const vb = camera.visibleBounds(64 / k);

    // ---------------------------------------------------------------- links
    const wb = this.weightBuckets;
    const linkStyleCount = this.styleLink && theme.linkStyles ? theme.linkStyles.length : 0;
    ensureBuckets(this.linkBuckets, (linkStyleCount + wb) * 2);
    for (const b of this.linkBuckets) b.length = 0;
    this.activeLinks.length = 0;

    const hoverIdx = frame.hover ? g.indexOf(frame.hover) : -1;

    for (let l = 0; l < g.linkCount; l++) {
      const s = g.linkSource[l]!;
      const t = g.linkTarget[l]!;
      if ((g.flags[s]! | g.flags[t]!) & FLAG_HIDDEN) continue;

      const sx = g.x[s]!;
      const sy = g.y[s]!;
      const tx = g.x[t]!;
      const ty = g.y[t]!;
      // Cull: the segment's bounding box against the viewport.
      if (
        Math.max(sx, tx) < vb.minX ||
        Math.min(sx, tx) > vb.maxX ||
        Math.max(sy, ty) < vb.minY ||
        Math.min(sy, ty) > vb.maxY
      ) {
        continue;
      }

      // Highlighting a touched link repaints it in one flat accent colour, which
      // destroys any encoding the consumer put ON the link. So it only applies
      // when the consumer has NOT supplied link styles — explicit styling wins.
      const touched =
        !this.styleLink &&
        (s === hoverIdx ||
          t === hoverIdx ||
          (g.flags[s]! & FLAG_SELECTED) !== 0 ||
          (g.flags[t]! & FLAG_SELECTED) !== 0);
      stats.linksDrawn++;
      if (touched) {
        this.activeLinks.push(l);
        continue;
      }

      // Bucket so links still batch: an explicit style class when the consumer
      // supplies one, otherwise weight quantised into `weightBuckets` steps.
      // A `-1` from the classifier means "use the built-in weight buckets". Those
      // must live in a DISJOINT index range, or bucket 2 would mean both "style 2"
      // and "weight bucket 2" and the draw loop could not tell them apart.
      const cls = this.styleLink ? this.styleLink(l, g) : -1;
      const q =
        cls >= 0
          ? cls
          : linkStyleCount +
            Math.min(wb - 1, Math.max(0, Math.floor(g.linkWeight[l]! * wb - 1e-9)));
      const dimmed = dim ? (dim[s] === 0 || dim[t] === 0 ? 1 : 0) : 0;
      ensureBuckets(this.linkBuckets, (q + 1) * 2);
      this.linkBuckets[q * 2 + dimmed]!.push(l);
    }

    const linkStyles = theme.linkStyles;
    // One shared dash offset for every animated style this frame. Direction is a
    // field on the spec, not the sign of this number.
    const dashPhase = animationPhase(this.dashAnim, frame.timeMs);

    const linkBucketCount = Math.floor(this.linkBuckets.length / 2);
    for (let q = 0; q < linkBucketCount; q++) {
      const style = q < linkStyleCount ? linkStyles![q] : undefined;
      for (let d = 0; d < 2; d++) {
        const bucket = this.linkBuckets[q * 2 + d]!;
        if (bucket.length === 0) continue;
        const baseAlpha = style?.alpha ?? 1;
        ctx.globalAlpha = d === 1 ? baseAlpha * theme.dimOpacity : baseAlpha;
        ctx.strokeStyle = style?.color ?? theme.link.color;
        ctx.lineWidth =
          style?.width ?? Math.max(0.4, ((q - linkStyleCount + 1) / wb) * 1.4);
        if (style?.dash) {
          ctx.setLineDash(style.dash);
          if (style.animateDash) {
            const period = style.dash.reduce((a, b) => a + b, 0);
            ctx.lineDashOffset = dashPhase * period;
            animating = true;
          }
        } else {
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        for (const l of bucket) {
          const s = g.linkSource[l]!;
          const t = g.linkTarget[l]!;
          ctx.moveTo(camera.toScreenX(g.x[s]!), camera.toScreenY(g.y[s]!));
          ctx.lineTo(camera.toScreenX(g.x[t]!), camera.toScreenY(g.y[t]!));
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    if (this.activeLinks.length > 0) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.link.active;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (const l of this.activeLinks) {
        const s = g.linkSource[l]!;
        const t = g.linkTarget[l]!;
        ctx.moveTo(camera.toScreenX(g.x[s]!), camera.toScreenY(g.y[s]!));
        ctx.lineTo(camera.toScreenX(g.x[t]!), camera.toScreenY(g.y[t]!));
      }
      ctx.stroke();
    }

    // ---------------------------------------------------------------- nodes
    const nodeStyleCount = this.styleNode && theme.nodeStyles ? theme.nodeStyles.length : 0;
    const slots = nodeStyleCount + theme.palette.length + 1; // styles + palette + "other"
    ensureBuckets(this.nodeBuckets, slots * 2);
    for (const b of this.nodeBuckets) b.length = 0;
    this.labelCandidates.length = 0;

    for (let i = 0; i < n; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      const wx = g.x[i]!;
      const wy = g.y[i]!;
      if (wx < vb.minX || wx > vb.maxX || wy < vb.minY || wy > vb.maxY) continue;

      // Same disjointness rule as links: an explicit style index and a palette
      // slot must not be able to name the same bucket.
      const cls = this.styleNode ? this.styleNode(i, g) : -1;
      const slot = palette.slotOf(g.types[i]!, theme.palette.length);
      const fallback = nodeStyleCount + (slot < 0 ? theme.palette.length : slot);
      const bucket = cls >= 0 ? cls : fallback;
      ensureBuckets(this.nodeBuckets, (bucket + 1) * 2);
      const dimmed = dim && dim[i] === 0 ? 1 : 0;
      this.nodeBuckets[bucket * 2 + dimmed]!.push(i);
      // Dimmed nodes are still label candidates — going recessive should not mean
      // going anonymous. They are drawn at the dim opacity further down.
      this.labelCandidates.push(i);
      stats.nodesDrawn++;
    }

    const nodeStyles = theme.nodeStyles;
    const nodeBucketCount = Math.max(slots, Math.floor(this.nodeBuckets.length / 2));
    for (let s = 0; s < nodeBucketCount; s++) {
      const style = s < nodeStyleCount ? nodeStyles![s] : undefined;
      const shape: NodeShape = style?.shape ?? 'circle';
      for (let d = 0; d < 2; d++) {
        const bucket = this.nodeBuckets[s * 2 + d]!;
        if (!bucket || bucket.length === 0) continue;
        ctx.globalAlpha = d === 1 ? theme.dimOpacity : 1;
        const slotIndex = s - nodeStyleCount;
        ctx.fillStyle =
          style?.fill ??
          (slotIndex === theme.palette.length
            ? theme.other
            : theme.palette[slotIndex] ?? theme.other);

        ctx.beginPath();
        for (const i of bucket) {
          const px = camera.toScreenX(g.x[i]!);
          const py = camera.toScreenY(g.y[i]!);
          const r = this.screenRadius(g.radius[i]!, k);
          this.tracePath(ctx, shape, px, py, r);
        }
        ctx.fill();

        // One stroke pass over the same batch, if this style has an outline.
        if (style?.stroke) {
          ctx.strokeStyle = style.stroke;
          ctx.lineWidth = style.strokeWidth ?? 1.4;
          ctx.setLineDash(style.dash ?? []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    ctx.globalAlpha = 1;

    // Consumer-drawn extra channels, once the fills are down.
    if (this.decorate) {
      if (this.decorateAnimates) animating = true;
      const info: DecorationInfo = {
        graph: g,
        x: 0,
        y: 0,
        r: 0,
        dimmed: false,
        selected: false,
        hovered: false,
        timeMs: frame.timeMs,
      };
      for (let s = 0; s < nodeBucketCount; s++) {
        for (let d = 0; d < 2; d++) {
          const bucket = this.nodeBuckets[s * 2 + d]!;
          if (!bucket) continue;
          for (const i of bucket) {
            info.x = camera.toScreenX(g.x[i]!);
            info.y = camera.toScreenY(g.y[i]!);
            info.r = this.screenRadius(g.radius[i]!, k);
            info.dimmed = d === 1;
            info.selected = (g.flags[i]! & FLAG_SELECTED) !== 0;
            info.hovered = i === hoverIdx;
            this.decorate(ctx, i, info);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // ------------------------------------------------------------- overlays
    // Pins, in one path. State is assigned only if the pass actually draws —
    // setting it for an empty path is a wasted driver flush and it makes
    // "which colour did we stroke with" unanswerable from the call log.
    ctx.beginPath();
    let pins = 0;
    for (let i = 0; i < n; i++) {
      const f = g.flags[i]!;
      if (f & FLAG_HIDDEN || !(f & FLAG_PINNED)) continue;
      const px = camera.toScreenX(g.x[i]!);
      const py = camera.toScreenY(g.y[i]!);
      if (px < -20 || py < -20 || px > this.cssWidth + 20 || py > this.cssHeight + 20) continue;
      const r = this.screenRadius(g.radius[i]!, k) + 3;
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, TAU);
      pins++;
    }
    if (pins > 0) {
      ctx.strokeStyle = theme.pin;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    // Selection ring. The pulse is a real animation with a positive duration and
    // an explicit direction — see `core/direction.ts` for why that is a rule.
    const phase = animationPhase(this.pulse, frame.timeMs);
    const breathe = 0.5 - 0.5 * Math.cos(phase * TAU); // 0 → 1 → 0
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let sel = 0;
    for (let i = 0; i < n; i++) {
      const f = g.flags[i]!;
      if (f & FLAG_HIDDEN || !(f & FLAG_SELECTED)) continue;
      const px = camera.toScreenX(g.x[i]!);
      const py = camera.toScreenY(g.y[i]!);
      const r = this.screenRadius(g.radius[i]!, k) + 4.5 + breathe * 2.5;
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, TAU);
      sel++;
    }
    if (sel > 0) {
      ctx.stroke();
      animating = true; // the ring breathes
    }

    // Hover ring.
    if (hoverIdx >= 0 && !(g.flags[hoverIdx]! & FLAG_HIDDEN)) {
      const px = camera.toScreenX(g.x[hoverIdx]!);
      const py = camera.toScreenY(g.y[hoverIdx]!);
      const r = this.screenRadius(g.radius[hoverIdx]!, k) + 3;
      ctx.strokeStyle = theme.hover;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.stroke();
    }

    // ---------------------------------------------------------------- labels
    // The hovered node ALWAYS gets a label, at any zoom. Three of the eight
    // light-mode palette slots sit under 3:1 against the surface, so colour
    // alone is not allowed to be the only thing identifying a node.
    ctx.font = this.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    if (k >= this.labelZoom) {
      this.labelCandidates.sort((a, b) => g.degree[b]! - g.degree[a]!);
      const count = Math.min(this.maxLabels, this.labelCandidates.length);
      for (let j = 0; j < count; j++) {
        const i = this.labelCandidates[j]!;
        if (i === hoverIdx) continue;
        const isDim = dim !== null && dim[i] === 0;
        // A style's own labelColor wins — a consumer that colours a node by
        // state usually wants its label to say the same thing.
        const st = this.styleNode && nodeStyles ? nodeStyles[this.styleNode(i, g)] : undefined;
        ctx.globalAlpha = isDim ? theme.dimOpacity : 1;
        this.drawLabel(frame, i, st?.labelColor ?? theme.label);
      }
      ctx.globalAlpha = 1;
    }
    if (hoverIdx >= 0 && !(g.flags[hoverIdx]! & FLAG_HIDDEN)) {
      this.drawLabel(frame, hoverIdx, theme.ink.primary);
    }

    // ------------------------------------------------------------- marquee
    if (frame.marquee) {
      const m = frame.marquee;
      const x = Math.min(m.x0, m.x1);
      const y = Math.min(m.y0, m.y1);
      const w = Math.abs(m.x1 - m.x0);
      const h = Math.abs(m.y1 - m.y0);
      ctx.strokeStyle = theme.ink.secondary;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.setLineDash([]);
    }

    if (this.showQuadtree) this.drawQuadtree(frame);

    this.animating = animating;
  }

  private drawLabel(frame: RenderFrame, i: number, color: string): void {
    const { graph: g, camera, theme } = frame;
    const ctx = this.ctx;
    const px = camera.toScreenX(g.x[i]!);
    const py = camera.toScreenY(g.y[i]!);
    if (px < -80 || py < -20 || px > this.cssWidth + 80 || py > this.cssHeight + 20) return;
    const r = this.screenRadius(g.radius[i]!, camera.k);
    const text = g.labels[i]!;
    const below = this.labelPlacement === 'below';
    const tx = below ? px : px + r + 4;
    const ty = below ? py + r + 7 : py;
    ctx.textAlign = below ? 'center' : 'left';
    ctx.textBaseline = below ? 'top' : 'middle';
    // Halo first so text stays readable where it crosses an edge.
    ctx.strokeStyle = theme.labelHalo;
    ctx.lineWidth = 3;
    ctx.strokeText(text, tx, ty);
    ctx.fillStyle = color;
    ctx.fillText(text, tx, ty);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    this.stats.labelsDrawn++;
  }

  /** Debug view of the Barnes-Hut subdivision — how the O(n log n) is earned. */
  private drawQuadtree(frame: RenderFrame): void {
    const ctx = this.ctx;
    const { camera, theme, tree } = frame;
    if (!tree) return;
    ctx.strokeStyle = theme.ink.muted;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let c = 0; c < tree.count; c++) {
      if (tree.bodies[c] === 0) continue;
      const h = tree.half[c]! * camera.k;
      const px = camera.toScreenX(tree.cx[c]!);
      const py = camera.toScreenY(tree.cy[c]!);
      if (h < 2) continue;
      ctx.rect(px - h, py - h, h * 2, h * 2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  destroy(): void {
    // Nothing retained beyond the canvas the consumer owns.
    this.nodeBuckets = [];
    this.linkBuckets = [];
  }
}

const TAU = Math.PI * 2;

function ensureBuckets(arr: number[][], n: number): void {
  while (arr.length < n) arr.push([]);
}
