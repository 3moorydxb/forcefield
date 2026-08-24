import type { Simulation } from '../core/simulation.js';
import type { Camera } from '../render/camera.js';
import { FLAG_DRAGGING, FLAG_HIDDEN } from '../core/graph.js';

export interface ControllerOptions {
  /** Alpha held while a drag is in progress. This is what makes the graph respond. */
  dragAlpha?: number;
  /** Alpha bump on a discrete interaction (click, pin, fit). */
  nudgeAlpha?: number;
  /** Wheel zoom sensitivity. */
  zoomSpeed?: number;
  /** Extra screen pixels around a node that still count as a hit. */
  pickTolerance?: number;
  /** Pixels of movement above which a press stops counting as a click. */
  clickSlop?: number;
  /** Bind keyboard shortcuts (p pin, f fit, Escape clear). */
  keyboard?: boolean;
}

export type ControllerEvent =
  | 'hover'
  | 'select'
  | 'nodeclick'
  | 'nodedblclick'
  | 'dragstart'
  | 'dragend'
  | 'pin'
  | 'camera'
  | 'background';

type Handler = (payload: unknown) => void;

/**
 * Pointer, wheel and keyboard interaction.
 *
 * The whole feel of the thing is one line of this file: **dragging a node raises
 * `alphaTarget`, so the simulation keeps running at a constant temperature for as
 * long as the mouse is down, and the rest of the graph rearranges itself around
 * the node in your hand.** Releasing drops the target back to zero and it cools.
 *
 * A one-shot `reheat()` is not enough and the difference is easy to feel: alpha
 * decays during the gesture, so the graph goes limp halfway through a slow drag —
 * which is exactly how a layout that is replaying stored coordinates behaves.
 *
 * Picking is a linear scan over visible nodes. At a few thousand nodes that is
 * microseconds per pointer move, and it is correct in a way a stale spatial
 * index is not — the physics tree is rebuilt every tick, and querying last
 * tick's tree during a drag picks the node that *was* there.
 */
export class InteractionController {
  hover: string | null = null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

  private readonly el: HTMLElement;
  private readonly sim: Simulation;
  private readonly camera: Camera;
  private readonly opts: Required<ControllerOptions>;

  private dragId: string | null = null;
  private dragOffX = 0;
  private dragOffY = 0;
  private panning = false;
  private pressX = 0;
  private pressY = 0;
  private moved = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;

  private handlers: Partial<Record<ControllerEvent, Handler[]>> = {};
  private bound: Array<[string, EventListener]> = [];

  constructor(el: HTMLElement, sim: Simulation, camera: Camera, opts: ControllerOptions = {}) {
    this.el = el;
    this.sim = sim;
    this.camera = camera;
    this.opts = {
      dragAlpha: opts.dragAlpha ?? 0.3,
      nudgeAlpha: opts.nudgeAlpha ?? 0.2,
      zoomSpeed: opts.zoomSpeed ?? 0.0016,
      pickTolerance: opts.pickTolerance ?? 6,
      clickSlop: opts.clickSlop ?? 4,
      keyboard: opts.keyboard ?? true,
    };

    this.bind('pointerdown', this.onPointerDown as EventListener);
    this.bind('pointermove', this.onPointerMove as EventListener);
    this.bind('pointerup', this.onPointerUp as EventListener);
    this.bind('pointercancel', this.onPointerUp as EventListener);
    this.bind('pointerleave', this.onPointerLeave as EventListener);
    this.bind('wheel', this.onWheel as EventListener, { passive: false });
    this.bind('dblclick', this.onDblClick as EventListener);
    this.bind('contextmenu', ((e: Event) => e.preventDefault()) as EventListener);
    if (this.opts.keyboard) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      this.bind('keydown', this.onKeyDown as EventListener);
    }
  }

  private bind(type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    this.el.addEventListener(type, fn, opts);
    this.bound.push([type, fn]);
  }

  on(event: ControllerEvent, fn: Handler): this {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  private emit(event: ControllerEvent, payload: unknown): void {
    const l = this.handlers[event];
    if (l) for (const fn of l) fn(payload);
  }

  // ---------------------------------------------------------------- picking

  /** Screen coordinates relative to the element. */
  private local(e: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Topmost visible node under a screen point, or `null`. */
  pick(sx: number, sy: number): string | null {
    const g = this.sim.graph;
    const k = this.camera.k;
    const tol = this.opts.pickTolerance;
    let best = -1;
    let bestD = Infinity;

    for (let i = 0; i < g.nodeCount; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      const px = this.camera.toScreenX(g.x[i]!);
      const py = this.camera.toScreenY(g.y[i]!);
      // Must agree with what the renderer drew, or small nodes are unclickable.
      const r = Math.max(3, g.radius[i]! * k) + tol;
      const dx = sx - px;
      const dy = sy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      // Prefer the node whose centre is nearest, so overlapping small nodes on
      // top of a large one are still reachable.
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best < 0 ? null : g.ids[best]!;
  }

  /** Visible node ids inside a screen-space rectangle. */
  pickRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const g = this.sim.graph;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const out: string[] = [];
    for (let i = 0; i < g.nodeCount; i++) {
      if (g.flags[i]! & FLAG_HIDDEN) continue;
      const px = this.camera.toScreenX(g.x[i]!);
      const py = this.camera.toScreenY(g.y[i]!);
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) out.push(g.ids[i]!);
    }
    return out;
  }

  // --------------------------------------------------------------- pointers

  private onPointerDown = (e: PointerEvent): void => {
    this.el.focus?.();
    this.el.setPointerCapture?.(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      // Second finger down — switch from pan to pinch.
      this.panning = false;
      this.endDrag(false);
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      return;
    }
    if (this.pointers.size > 2) return;

    this.pressX = p.x;
    this.pressY = p.y;
    this.moved = 0;

    const id = this.pick(p.x, p.y);
    if (id) {
      this.beginDrag(id, p.x, p.y);
      return;
    }

    if (e.shiftKey) {
      this.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else {
      this.panning = true;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.local(e);
    const prev = this.pointers.get(e.pointerId);
    if (prev) this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (this.pinchDist > 0 && d > 0) {
        const cx = (a!.x + b!.x) / 2;
        const cy = (a!.y + b!.y) / 2;
        this.camera.zoomAt(cx, cy, d / this.pinchDist);
        this.emit('camera', this.camera);
      }
      this.pinchDist = d;
      return;
    }

    if (prev) this.moved += Math.hypot(p.x - prev.x, p.y - prev.y);

    if (this.dragId) {
      const g = this.sim.graph;
      g.setPosition(
        this.dragId,
        this.camera.toWorldX(p.x) + this.dragOffX,
        this.camera.toWorldY(p.y) + this.dragOffY,
      );
      // Hold the temperature up rather than bumping it: a one-shot reheat decays
      // during a slow drag and the graph stops responding halfway through.
      this.sim.reheat(this.opts.dragAlpha);
      return;
    }

    if (this.marquee) {
      this.marquee.x1 = p.x;
      this.marquee.y1 = p.y;
      return;
    }

    if (this.panning && prev) {
      this.camera.panBy(p.x - this.pressX, p.y - this.pressY);
      this.pressX = p.x;
      this.pressY = p.y;
      this.emit('camera', this.camera);
      return;
    }

    const id = this.pick(p.x, p.y);
    if (id !== this.hover) {
      this.hover = id;
      this.el.style.cursor = id ? 'pointer' : 'default';
      this.emit('hover', id);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0;
    this.el.releasePointerCapture?.(e.pointerId);

    const wasClick = this.moved <= this.opts.clickSlop;

    if (this.dragId) {
      const id = this.dragId;
      this.endDrag(true);
      if (wasClick) this.select(id, e.shiftKey || e.metaKey || e.ctrlKey);
      return;
    }

    if (this.marquee) {
      const ids = this.pickRect(this.marquee.x0, this.marquee.y0, p.x, p.y);
      const g = this.sim.graph;
      if (!(e.metaKey || e.ctrlKey)) g.clearSelection();
      for (const id of ids) g.setSelected(id, true);
      this.marquee = null;
      this.emit('select', g.selectedIds());
      return;
    }

    if (this.panning) {
      this.panning = false;
      if (wasClick) {
        this.sim.graph.clearSelection();
        this.emit('select', []);
        this.emit('background', { x: p.x, y: p.y });
      }
    }
  };

  private onPointerLeave = (): void => {
    if (this.hover !== null) {
      this.hover = null;
      this.emit('hover', null);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.local(e);
    // A positive multiplier either side of 1. Scroll direction picks which side;
    // the factor itself is never negative — see core/direction.ts.
    const factor = Math.exp(-e.deltaY * this.opts.zoomSpeed);
    this.camera.zoomAt(p.x, p.y, factor);
    this.emit('camera', this.camera);
  };

  private onDblClick = (e: MouseEvent): void => {
    const p = this.local(e);
    const id = this.pick(p.x, p.y);
    if (!id) return;
    const g = this.sim.graph;
    const now = !g.isPinned(id);
    g.setPinned(id, now);
    this.sim.reheat(this.opts.nudgeAlpha);
    this.emit('nodedblclick', id);
    this.emit('pin', { id, pinned: now });
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const g = this.sim.graph;
    if (e.key === 'Escape') {
      g.clearSelection();
      this.emit('select', []);
    } else if (e.key === 'p' || e.key === 'P') {
      const ids = g.selectedIds();
      if (ids.length === 0) return;
      // Toggle as a group: if any is unpinned, pin them all. Otherwise unpin.
      const anyUnpinned = ids.some((id) => !g.isPinned(id));
      for (const id of ids) g.setPinned(id, anyUnpinned);
      this.sim.reheat(this.opts.nudgeAlpha);
      this.emit('pin', { ids, pinned: anyUnpinned });
    } else if (e.key === 'f' || e.key === 'F') {
      const b = this.sim.bounds();
      if (b) {
        this.camera.fit(b);
        this.emit('camera', this.camera);
      }
    } else {
      return;
    }
    e.preventDefault();
  };

  // ------------------------------------------------------------------ drag

  private beginDrag(id: string, sx: number, sy: number): void {
    const g = this.sim.graph;
    const i = g.indexOf(id);
    if (i < 0) return;
    this.dragId = id;
    this.dragOffX = g.x[i]! - this.camera.toWorldX(sx);
    this.dragOffY = g.y[i]! - this.camera.toWorldY(sy);
    g.flags[i]! |= FLAG_DRAGGING;
    g.vx[i] = 0;
    g.vy[i] = 0;
    // Raise the FLOOR, not just the current value: alphaTarget keeps the
    // simulation warm for the whole gesture instead of cooling under the cursor.
    this.sim.alphaTarget = this.opts.dragAlpha;
    this.sim.reheat(this.opts.dragAlpha);
    this.emit('dragstart', id);
  }

  private endDrag(emit: boolean): void {
    if (!this.dragId) return;
    const g = this.sim.graph;
    const i = g.indexOf(this.dragId);
    if (i >= 0) g.flags[i]! &= ~FLAG_DRAGGING;
    this.sim.alphaTarget = 0;
    const id = this.dragId;
    this.dragId = null;
    if (emit) this.emit('dragend', id);
  }

  private select(id: string, additive: boolean): void {
    const g = this.sim.graph;
    if (additive) {
      g.setSelected(id, !g.isSelected(id));
    } else {
      g.clearSelection();
      g.setSelected(id, true);
    }
    this.emit('nodeclick', id);
    this.emit('select', g.selectedIds());
  }

  destroy(): void {
    for (const [type, fn] of this.bound) this.el.removeEventListener(type, fn);
    this.bound = [];
    this.handlers = {};
  }
}
