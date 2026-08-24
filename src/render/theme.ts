import type { Graph } from '../core/graph.js';

/**
 * Node geometry. Pure shape names — the engine has no idea why a consumer wants
 * a diamond, and must not.
 *
 * `square-in-square` draws two concentric rects in ONE subpath set. Canvas
 * `rect()` always winds clockwise, so under the default nonzero fill rule the
 * inner square is filled, not knocked out. Switching the fill rule to `evenodd`
 * silently turns it into a ring — which is a different symbol, so don't.
 */
export type NodeShape =
  | 'circle'
  | 'square'
  | 'diamond'
  | 'triangle'
  | 'hexagon'
  | 'square-in-square';

/**
 * One bucket of node appearance.
 *
 * Styles are addressed by INDEX, not looked up per node, so the renderer can
 * still batch: every node sharing a style index goes into one path and is filled
 * once. A consumer that returned a fresh style object per node would turn twenty
 * driver state changes back into several thousand.
 */
export interface NodeStyle {
  fill: string;
  stroke?: string;
  strokeWidth?: number;
  /** Dash pattern for the stroke, in screen pixels. */
  dash?: number[];
  shape?: NodeShape;
  labelColor?: string;
}

/** One bucket of link appearance. Same batching contract as `NodeStyle`. */
export interface LinkStyle {
  color: string;
  width?: number;
  alpha?: number;
  dash?: number[];
  /**
   * Animate this style's dash offset ("marching ants").
   *
   * Direction is an explicit field on the animation spec, never the sign of the
   * offset — see `core/direction.ts` for the incident that rule comes from.
   */
  animateDash?: boolean;
}

/**
 * Theming.
 *
 * The engine ships a **brand-neutral placeholder palette and nothing else.** It
 * has no idea what a node means, so it cannot have an opinion about what colour
 * one should be. Consumers replace `palette` wholesale; everything here is a
 * default that exists so the first run is legible, not so it is on-brand.
 *
 * The default categorical hues are the validated eight-slot set: colourblind-safe
 * (worst adjacent pair ΔE 8.4 protan on dark, 9.1 on light), inside the lightness
 * band for each surface, above the chroma floor. On the DARK surface all eight
 * clear 3:1 against the background. On the LIGHT surface three of the eight sit
 * below 3:1 — which is why `Canvas2DRenderer` draws a node label on hover and
 * why the examples ship a legend. Identity is never carried by colour alone.
 */
export interface Theme {
  name: string;
  /** Page behind the canvas. */
  background: string;
  ink: {
    primary: string;
    secondary: string;
    muted: string;
  };
  /** Eight categorical slots, assigned in fixed order and never cycled. */
  palette: readonly string[];
  /** Slot 9 and beyond fold into this. A generated ninth hue is not a category. */
  other: string;
  link: {
    color: string;
    /** Links touching the hovered or selected node. */
    active: string;
  };
  /** Ring drawn around the selected node — chrome, deliberately not a palette hue. */
  selection: string;
  hover: string;
  /** Ring marking a pinned node. */
  pin: string;
  label: string;
  /** Drawn behind label text so it stays readable over edges. */
  labelHalo: string;
  /** Opacity applied to anything outside the highlight set in dim mode. */
  dimOpacity: number;

  /**
   * Optional explicit style buckets, used instead of `palette` when the
   * renderer is given a `styleNode` / `styleLink` classifier. This is the seam a
   * consumer with real semantics (shapes, a confidence ladder, a quarantine
   * state) uses — it supplies the meaning, the engine supplies the batching.
   */
  nodeStyles?: NodeStyle[];
  linkStyles?: LinkStyle[];
}

export const darkTheme: Theme = {
  name: 'dark',
  background: '#1a1a19',
  ink: { primary: '#ffffff', secondary: '#c3c2b7', muted: '#898781' },
  palette: [
    '#3987e5', // 1 blue
    '#d95926', // 2 orange
    '#199e70', // 3 aqua
    '#c98500', // 4 yellow
    '#d55181', // 5 magenta
    '#008300', // 6 green
    '#9085e9', // 7 violet
    '#e66767', // 8 red
  ],
  other: '#898781',
  link: { color: '#3a3a37', active: '#c3c2b7' },
  selection: '#ffffff',
  hover: '#c3c2b7',
  pin: '#c3c2b7',
  label: '#c3c2b7',
  labelHalo: '#1a1a19',
  dimOpacity: 0.16,
};

export const lightTheme: Theme = {
  name: 'light',
  background: '#fcfcfb',
  ink: { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781' },
  palette: [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
  ],
  other: '#898781',
  link: { color: '#dedcd4', active: '#52514e' },
  selection: '#0b0b0b',
  hover: '#52514e',
  pin: '#52514e',
  label: '#52514e',
  labelHalo: '#fcfcfb',
  dimOpacity: 0.18,
};

/**
 * Maps a consumer's `type` strings onto palette slots.
 *
 * Two rules, both of which exist because breaking them makes a graph lie:
 *
 * 1. **Fixed order, never cycled.** Types are assigned slots once, by descending
 *    frequency then alphabetically, over the WHOLE graph. A type that does not
 *    fit in eight gets `other` — a ninth generated hue would sit somewhere
 *    arbitrary in colour space and read as a category it is not.
 * 2. **Colour follows the entity, not its rank.** Because assignment is computed
 *    from the whole graph, filtering down to three types does not repaint them.
 *    A colour that moves when you filter teaches the reader the wrong thing.
 */
export class TypePalette {
  private slot = new Map<string, number>();
  private counts = new Map<string, number>();

  /** Assign slots from every type present in `graph`. Call once after loading. */
  assignFrom(graph: Graph): this {
    this.counts.clear();
    for (let i = 0; i < graph.nodeCount; i++) {
      const t = graph.types[i]!;
      this.counts.set(t, (this.counts.get(t) ?? 0) + 1);
    }
    const ordered = [...this.counts.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    this.slot.clear();
    ordered.forEach(([t], i) => this.slot.set(t, i));
    return this;
  }

  /** Assign an explicit order — for when the consumer knows better than frequency. */
  assignExplicit(types: string[]): this {
    this.slot.clear();
    types.forEach((t, i) => this.slot.set(t, i));
    return this;
  }

  /** `0..7` for a slotted type, `-1` for everything else (drawn as `other`). */
  slotOf(type: string, size = 8): number {
    const s = this.slot.get(type);
    return s === undefined || s >= size ? -1 : s;
  }

  colorOf(type: string, theme: Theme): string {
    const s = this.slotOf(type, theme.palette.length);
    return s < 0 ? theme.other : theme.palette[s]!;
  }

  /**
   * Legend entries, in slot order, with the overflow folded into one `Other`
   * row that names how many types it hides — a legend that silently omits
   * eleven categories is worse than no legend.
   */
  legend(theme: Theme): { label: string; color: string; count: number }[] {
    const size = theme.palette.length;
    const rows: { label: string; color: string; count: number }[] = [];
    let otherCount = 0;
    let otherTypes = 0;
    for (const [type, s] of this.slot) {
      const c = this.counts.get(type) ?? 0;
      if (s < size) rows.push({ label: type || '(untyped)', color: theme.palette[s]!, count: c });
      else {
        otherCount += c;
        otherTypes++;
      }
    }
    rows.sort((a, b) => b.count - a.count);
    if (otherTypes > 0) {
      rows.push({
        label: `Other (${otherTypes} type${otherTypes === 1 ? '' : 's'})`,
        color: theme.other,
        count: otherCount,
      });
    }
    return rows;
  }
}
