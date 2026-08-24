# themes/

A `Theme` tells the renderer what to draw with — colours, chrome, and
(optionally) explicit style buckets. The engine ships three: `dark`, `light`,
and `midnight-glow`. This folder is the whole contribution surface: everything
you need to add a theme lives here, and nothing in here depends on the engine
in `src/`.

## What a Theme is

```ts
export interface Theme {
  name: string;
  /** Page behind the canvas. */
  background: string;
  ink: {
    primary: string;   // body text
    secondary: string;  // less prominent text
    muted: string;      // least prominent text
  };
  /** Eight categorical slots, assigned in fixed order and never cycled. */
  palette: readonly string[];
  /** Slot 9 and beyond fold into this. A generated ninth hue is not a category. */
  other: string;
  link: {
    color: string;   // resting link colour
    active: string;  // links touching the hovered or selected node
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
   * renderer is given a `styleNode` / `styleLink` classifier. The consumer
   * supplies the meaning (shapes, a graded scale, an excluded state); the
   * engine supplies the batching.
   */
  nodeStyles?: NodeStyle[];
  linkStyles?: LinkStyle[];
}
```

`NodeStyle` and `LinkStyle` (also in `contract.ts`) are the per-bucket shapes
used by `nodeStyles` / `linkStyles`. See their doc comments in `contract.ts` for
the batching contract each one has to honour.

## How to add a theme

1. Copy `dark.ts` (or `light.ts`) to a new file, e.g. `sunset.ts`.
2. Change every value. `contract.ts` only cares about the numbers, not the
   colour scheme — pick whatever fits.
3. Register it in `index.ts`: import it, add it to the `themes` array, add it
   to the `export * from`/`export {}` lines.
4. Run `npm test`.

That's the whole process. Step 4 is not optional: `index.ts` runs every
theme in the array through `assertTheme` **at module load**, so a theme that
fails the contract does not just fail a test — the package fails to import at
all. A broken theme cannot be merged; the registry itself enforces that, not a
reviewer's memory of the rules.

## The contrast rule, and why it exists

Every rule below traces back to one sentence, from the console `midnight-glow`
is sourced from (an operator console this engine also drives — pink-on-black
by design): **pink-on-black is a contrast hazard and a colour-blind operator
must read the same information.** State is glyph + word + colour, never colour
alone. A theme is allowed to choose colours; it is not allowed to make colour
the only channel, and it is not allowed to make the fallback channels
unreadable.

| Rule | What it checks | Threshold | Why |
|---|---|---|---|
| R1 palette-shape | `palette` has >= 3 entries, every entry parses as a colour, no two identical | — | A palette with duplicate or unparseable slots silently collapses categories into each other. |
| R2 readable text | `ink.primary`, `label` vs `background`; `ink.secondary`, `ink.muted` vs `background` | 4.5:1 / 4.5:1 / 3:1 / 3:1 | Body text and the hover label are the primary read surface — WCAG AA body-text and large-text floors. |
| R3 the fallback channel survives | `label` vs `labelHalo` | 4.5:1 | **The rule with the teeth.** The hovered-node label is the second channel that rescues a low-contrast palette — three of the eight light-mode slots sit under 3:1 and that is accepted precisely because identity is never carried by colour alone. A theme that makes the label unreadable over its own halo deletes that fallback and turns identity back into colour-only. |
| R4 state chrome is visible | `selection`, `hover`, `pin` vs `background` | 3:1 each | Selection/hover/pin rings are the interaction affordances; if they disappear into the background the interaction is invisible, not just ugly. |
| R5 nothing is invisible | every `palette` slot, `other`, `link.active` vs `background`; `link.color` vs `background` | 1.5:1 / 1.5:1 / 1.5:1 / 1.2:1 | The floor below which a colour is not "low contrast", it is not there. `link.color` gets a lower floor because a resting link is *meant* to be faint — it should recede, not vanish. |
| R6 dimming is not disappearing | `dimOpacity` | finite, in `[0.05, 0.6]` | Dim mode recedes the non-highlighted set; it must not delete it (0) or fail to dim it at all (near 1). |
| R7 state is never colour alone | every pair in `nodeStyles` differs in `shape`/`dash`/`strokeWidth`; every pair in `linkStyles` differs in `width`/`dash`/`animateDash` | — | Two buckets separated only by `fill`/`stroke` (or `color`/`alpha`) is exactly the failure this whole contract exists to make impossible: a colour-blind reader loses the distinction entirely. |

Every problem `validateTheme` returns carries the **measured number**, e.g.
`"contrast(label, background) = 2.31, needs >= 4.5"`. A validator that says
"failed" without the number is the same failure class as a check that reports
success while doing nothing.

## Measured: the three shipped themes

All computed by running `contrast()` against the actual theme objects — not
estimated.

| Theme | label/background | label/labelHalo (R3) | selection/background | worst palette slot |
|---|---|---|---|---|
| dark | 9.72 | 9.72 | 17.42 | `#008300` → 3.52 |
| light | 7.73 | 7.73 | 19.17 | `#eda100` → 2.11 |
| midnight-glow | 7.15 | 7.15 | 7.19 | `#5e1a3c` → 1.64 |

(`label/labelHalo` equals `label/background` for all three because every
shipped theme sets `labelHalo` to its own `background` — the halo is a solid
plate behind the text, not a distinct colour.)

Full per-theme numbers, for reference (`ink.primary`, `ink.secondary`,
`ink.muted`, `hover`, `pin`, `link.color`, `link.active`, `other`, all vs
`background`):

| | dark | light | midnight-glow |
|---|---|---|---|
| ink.primary | 17.42 | 19.17 | 17.02 |
| ink.secondary | 9.72 | 7.73 | 7.15 |
| ink.muted | 4.85 | 3.50 | 3.20 |
| hover | 9.72 | 7.73 | 5.88 |
| pin | 9.72 | 7.73 | 17.02 |
| link.color | 1.53 | 1.34 | 1.24 |
| link.active | 9.72 | 7.73 | 7.19 |
| other | 4.85 | 3.50 | 3.20 |

Note the R5 floors are deliberately thin: `link.color` on every shipped theme
sits just above its 1.2:1 floor (1.24-1.53), and `midnight-glow`'s worst
palette slot (`#5e1a3c`, `--px-conf-low`) sits at 1.64, barely over the 1.5:1
floor. That is intentional — a resting link or a low-confidence categorical
slot is *supposed* to read as recessive, not loud.

## What the contract does NOT guarantee

The contract enforces readability and a non-colour fallback channel. It does
**not** guarantee categorical colour separation between palette slots —
`midnight-glow` is the proof. It is deliberately near-monochrome: five of its
eight palette slots (`accent`, `accent-2`, `accent-deep`, `conf-med`,
`conf-low`) live in the same pink/magenta family, by the source console's own
design rule ("ONE accent. Pink means STATE — never decoration, never a mood").
Every one of those slots individually clears the R5 visibility floor and would
individually clear R2/R4 if used as text or chrome — but two of them sitting
next to each other in a legend can be genuinely hard to tell apart by hue
alone.

This is exactly why the contract never lets colour be the only channel: R7
forces any theme that needs a colour-blind-safe *categorical* distinction (not
just "is this colour visible") to also vary `nodeStyles`/`linkStyles` on shape,
dash, or stroke width. `midnight-glow` ships without `nodeStyles`/`linkStyles`
of its own — it relies on the default palette-plus-label fallback (R3) the
same way `light` does for its own under-3:1 slots. A consumer who wants
`midnight-glow` with genuinely distinct categories should supply `nodeStyles`
that vary shape, and the contract will refuse to register the theme if it
tries to fake that distinction with colour alone.
