/**
 * The Theme contract.
 *
 * This file imports NOTHING from `src/`. That is deliberate: `themes/` is the
 * whole contribution surface for anyone adding a palette, and a contributor
 * should be able to read this one file — types, rules, and the validator that
 * enforces them — without ever opening the engine.
 */

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
   * consumer with real semantics (shapes, a graded scale, an excluded state)
   * uses — it supplies the meaning, the engine supplies the batching.
   */
  nodeStyles?: NodeStyle[];
  linkStyles?: LinkStyle[];
}

// ------------------------------------------------------------- validation

/** One thing wrong with a theme, with the measured number that proves it. */
export interface ThemeProblem {
  field: string;
  /** The R-number and a short name, e.g. "R2 readable text". */
  rule: string;
  /** The measured value and the threshold, e.g. "contrast(label, background) = 2.31, needs >= 4.5". */
  detail: string;
}

export class ThemeError extends Error {
  readonly problems: ThemeProblem[];

  constructor(themeName: string, problems: ThemeProblem[]) {
    super(
      `theme "${themeName}" fails its contract (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - [${p.rule}] ${p.field}: ${p.detail}`).join('\n'),
    );
    this.name = 'ThemeError';
    this.problems = problems;
  }
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored — contrast is a colour
 * question, not a compositing one). Anything else throws: a theme that sets a
 * colour this cannot parse is a broken theme, not a tolerated one.
 */
function parseColor(hex: string): Rgb {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(hex.trim());
  if (!m) {
    throw new Error(`contrast(): "${hex}" is not a #rgb / #rrggbb / #rrggbbaa colour`);
  }
  const s = m[1]!;
  if (s.length === 3) {
    const r = parseInt(s[0]! + s[0], 16);
    const g = parseInt(s[1]! + s[1], 16);
    const b = parseInt(s[2]! + s[2], 16);
    return { r, g, b };
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return { r, g, b };
}

function channelToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/**
 * WCAG 2.1 contrast ratio, 1..21. Equal colours (including a colour against
 * itself) come out to exactly 1.
 */
export function contrast(a: string, b: string): number {
  const la = relativeLuminance(parseColor(a));
  const lb = relativeLuminance(parseColor(b));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function pushIfBelow(
  problems: ThemeProblem[],
  field: string,
  rule: string,
  value: number,
  min: number,
  what: string,
): void {
  if (value < min) {
    problems.push({
      field,
      rule,
      detail: `${what} = ${fmt(value)}, needs >= ${fmt(min)}`,
    });
  }
}

function pushIfOutside(
  problems: ThemeProblem[],
  field: string,
  rule: string,
  value: number,
  min: number,
  max: number,
  what: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    problems.push({
      field,
      rule,
      detail: `${what} = ${Number.isFinite(value) ? fmt(value) : String(value)}, needs to be finite and in [${fmt(min)}, ${fmt(max)}]`,
    });
  }
}

/**
 * Non-colour channels a style can differ on. Two styles that agree on all of
 * these differ ONLY in colour — which is exactly the failure R7 exists to
 * catch.
 */
function nodeStyleShapeKey(s: NodeStyle): string {
  const dash = s.dash ? s.dash.join(',') : '';
  return `${s.shape ?? 'circle'}|${dash}|${s.strokeWidth ?? ''}`;
}

function linkStyleShapeKey(s: LinkStyle): string {
  const dash = s.dash ? s.dash.join(',') : '';
  return `${s.width ?? ''}|${dash}|${s.animateDash ?? false}`;
}

/**
 * Validate a theme against the contract. Returns `[]` when it passes — an
 * empty array IS the pass, there is no separate boolean to drift out of sync
 * with it.
 *
 * The rules exist because of one sentence from the console this flagship theme
 * (`midnight-glow`) comes from: pink-on-black is a contrast hazard and a
 * colour-blind operator must read the same information. State is GLYPH + WORD
 * + colour, never colour alone. A theme may choose colours; it may not make
 * colour the only channel, and it may not make the fallback channels unreadable.
 */
export function validateTheme(t: Theme): ThemeProblem[] {
  const problems: ThemeProblem[] = [];

  // Every colour field gets a chance to throw a parse error before we do any
  // numeric comparisons — a colour we cannot parse is not a "low contrast"
  // finding, it is a different failure, so surface it as its own problem
  // rather than letting it crash validateTheme entirely.
  const tryContrast = (field: string, rule: string, a: string, b: string): number | null => {
    try {
      return contrast(a, b);
    } catch (err) {
      problems.push({ field, rule, detail: (err as Error).message });
      return null;
    }
  };

  // R1 palette-shape — at least 3 entries, every entry parses, no two identical.
  if (t.palette.length < 3) {
    problems.push({
      field: 'palette',
      rule: 'R1 palette-shape',
      detail: `palette has ${t.palette.length} entries, needs >= 3`,
    });
  }
  const seen = new Map<string, number>();
  t.palette.forEach((hex, i) => {
    try {
      parseColor(hex);
    } catch (err) {
      problems.push({ field: `palette[${i}]`, rule: 'R1 palette-shape', detail: (err as Error).message });
    }
    const prior = seen.get(hex);
    if (prior !== undefined) {
      problems.push({
        field: `palette[${i}]`,
        rule: 'R1 palette-shape',
        detail: `duplicate of palette[${prior}] ("${hex}") — every slot must be distinct`,
      });
    }
    seen.set(hex, i);
  });

  // R2 readable text.
  {
    const c = tryContrast('ink.primary', 'R2 readable text', t.ink.primary, t.background);
    if (c !== null) pushIfBelow(problems, 'ink.primary', 'R2 readable text', c, 4.5, 'contrast(ink.primary, background)');
  }
  {
    const c = tryContrast('label', 'R2 readable text', t.label, t.background);
    if (c !== null) pushIfBelow(problems, 'label', 'R2 readable text', c, 4.5, 'contrast(label, background)');
  }
  {
    const c = tryContrast('ink.secondary', 'R2 readable text', t.ink.secondary, t.background);
    if (c !== null) pushIfBelow(problems, 'ink.secondary', 'R2 readable text', c, 3, 'contrast(ink.secondary, background)');
  }
  {
    const c = tryContrast('ink.muted', 'R2 readable text', t.ink.muted, t.background);
    if (c !== null) pushIfBelow(problems, 'ink.muted', 'R2 readable text', c, 3, 'contrast(ink.muted, background)');
  }

  // R3 the fallback channel survives — THIS IS THE RULE WITH THE TEETH. The
  // hovered-node label is the second channel that rescues a low-contrast
  // palette (three of the eight light-mode slots sit under 3:1 and that is
  // accepted precisely because identity is never carried by colour alone). A
  // theme that makes the label unreadable over its own halo deletes the
  // fallback and thereby turns identity back into colour-only.
  {
    const c = tryContrast('label/labelHalo', 'R3 the fallback channel survives', t.label, t.labelHalo);
    if (c !== null)
      pushIfBelow(problems, 'label/labelHalo', 'R3 the fallback channel survives', c, 4.5, 'contrast(label, labelHalo)');
  }

  // R4 state chrome is visible.
  {
    const c = tryContrast('selection', 'R4 state chrome is visible', t.selection, t.background);
    if (c !== null) pushIfBelow(problems, 'selection', 'R4 state chrome is visible', c, 3, 'contrast(selection, background)');
  }
  {
    const c = tryContrast('hover', 'R4 state chrome is visible', t.hover, t.background);
    if (c !== null) pushIfBelow(problems, 'hover', 'R4 state chrome is visible', c, 3, 'contrast(hover, background)');
  }
  {
    const c = tryContrast('pin', 'R4 state chrome is visible', t.pin, t.background);
    if (c !== null) pushIfBelow(problems, 'pin', 'R4 state chrome is visible', c, 3, 'contrast(pin, background)');
  }

  // R5 nothing is invisible — every palette slot, `other`, and `link.active`
  // clear 1.5:1 against `background`; `link.color` clears 1.2:1.
  t.palette.forEach((hex, i) => {
    const c = tryContrast(`palette[${i}]`, 'R5 nothing is invisible', hex, t.background);
    if (c !== null) pushIfBelow(problems, `palette[${i}]`, 'R5 nothing is invisible', c, 1.5, `contrast(palette[${i}], background)`);
  });
  {
    const c = tryContrast('other', 'R5 nothing is invisible', t.other, t.background);
    if (c !== null) pushIfBelow(problems, 'other', 'R5 nothing is invisible', c, 1.5, 'contrast(other, background)');
  }
  {
    const c = tryContrast('link.active', 'R5 nothing is invisible', t.link.active, t.background);
    if (c !== null) pushIfBelow(problems, 'link.active', 'R5 nothing is invisible', c, 1.5, 'contrast(link.active, background)');
  }
  {
    const c = tryContrast('link.color', 'R5 nothing is invisible', t.link.color, t.background);
    if (c !== null) pushIfBelow(problems, 'link.color', 'R5 nothing is invisible', c, 1.2, 'contrast(link.color, background)');
  }

  // R6 dimming is not disappearing.
  pushIfOutside(problems, 'dimOpacity', 'R6 dimming is not disappearing', t.dimOpacity, 0.05, 0.6, 'dimOpacity');

  // R7 state is never colour alone. If nodeStyles/linkStyles are supplied,
  // every PAIR must differ in a non-colour channel. Two buckets separated only
  // by fill/stroke (or colour/alpha for links) is exactly the failure this
  // contract exists to make impossible.
  //
  // 🔴 The `Array.isArray` guards below are not defensive noise. An audit of
  // this file found that passing `nodeStyles` a plain object instead of an
  // array made `.length` `undefined`, so the loop ran zero times and
  // `validateTheme` returned `[]` — the rule with the teeth passing a theme it
  // had never looked at. A check that reports success while doing nothing is
  // the exact failure this contract was written against, so the wrong SHAPE is
  // now a problem in its own right rather than a silent skip.
  if (t.nodeStyles !== undefined && !Array.isArray(t.nodeStyles)) {
    problems.push({
      field: 'nodeStyles',
      rule: 'R7 state is never colour alone',
      detail: `nodeStyles is ${typeof t.nodeStyles}, needs to be an array — styles are addressed by index, and a non-array skips this rule entirely`,
    });
  } else if (t.nodeStyles) {
    for (let i = 0; i < t.nodeStyles.length; i++) {
      for (let j = i + 1; j < t.nodeStyles.length; j++) {
        const a = t.nodeStyles[i]!;
        const b = t.nodeStyles[j]!;
        if (nodeStyleShapeKey(a) === nodeStyleShapeKey(b)) {
          problems.push({
            field: `nodeStyles[${i}]/nodeStyles[${j}]`,
            rule: 'R7 state is never colour alone',
            detail: `nodeStyles[${i}] and nodeStyles[${j}] share shape "${nodeStyleShapeKey(a)}" — they differ only in colour`,
          });
        }
      }
    }
  }
  if (t.linkStyles !== undefined && !Array.isArray(t.linkStyles)) {
    problems.push({
      field: 'linkStyles',
      rule: 'R7 state is never colour alone',
      detail: `linkStyles is ${typeof t.linkStyles}, needs to be an array — styles are addressed by index, and a non-array skips this rule entirely`,
    });
  } else if (t.linkStyles) {
    for (let i = 0; i < t.linkStyles.length; i++) {
      for (let j = i + 1; j < t.linkStyles.length; j++) {
        const a = t.linkStyles[i]!;
        const b = t.linkStyles[j]!;
        if (linkStyleShapeKey(a) === linkStyleShapeKey(b)) {
          problems.push({
            field: `linkStyles[${i}]/linkStyles[${j}]`,
            rule: 'R7 state is never colour alone',
            detail: `linkStyles[${i}] and linkStyles[${j}] share width/dash/animateDash "${linkStyleShapeKey(a)}" — they differ only in colour`,
          });
        }
      }
    }
  }

  return problems;
}

/** Validate and throw, naming every problem, or return the theme unchanged. */
export function assertTheme(t: Theme): Theme {
  const problems = validateTheme(t);
  if (problems.length > 0) {
    throw new ThemeError(t.name, problems);
  }
  return t;
}
