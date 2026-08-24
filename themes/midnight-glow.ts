import type { Theme } from './contract.js';

/**
 * midnight-glow.
 *
 * Sourced from the CSS custom properties of an operator console this engine
 * also drives — a near-monochrome pink-on-black theme built around a single
 * accent. Every value below is traceable to one of that theme's variables
 * (named in the trailing comments); nothing here is invented.
 *
 * That console's own rule is worth repeating because it is the exact reason
 * this contract exists: "pink-on-black is a contrast hazard and a colour-blind
 * operator must read the same information" — colour is never the only channel,
 * state is glyph + word + colour.
 *
 * Its palette is pink-dominated BY DESIGN ("ONE accent. Pink means STATE."),
 * so the eight categorical slots below have weak separation on purpose — five
 * of the eight sit in the same pink/magenta family. That is not hidden here;
 * see `themes/README.md`, which points at this theme as the proof that the
 * contract does not (and cannot) guarantee categorical colour separation.
 *
 * `link.color` is derived, not lifted: the source's `--px-line` is
 * `rgba(255, 45, 149, 0.22)`, and the contract only parses opaque hex, so this
 * is that colour composited over `--px-bg` (#050505) — `#3c0e25`, computed as
 * `round(255*0.22 + 5*0.78), round(45*0.22 + 5*0.78), round(149*0.22 + 5*0.78)`.
 * It lands at contrast 1.24:1 against the background, just over the 1.2:1 R5
 * floor for a resting, barely-there link colour — that thinness is the point,
 * it is meant to disappear until a link is active.
 *
 * Every rule (R1-R7) passes with the values below unmodified — see the
 * measured table in `themes/README.md`.
 */
export const midnightGlow: Theme = {
  name: 'midnight-glow',
  background: '#050505', // --px-bg
  ink: {
    primary: '#f7e6f0', // --px-text
    secondary: '#b98ca6', // --px-muted
    muted: '#7a5468', // --px-muted-2
  },
  palette: [
    '#ff2d95', // --px-accent
    '#ff5cb0', // --px-accent-2
    '#7a0f45', // --px-accent-deep
    '#b82470', // --px-conf-med
    '#5e1a3c', // --px-conf-low
    '#3fb950', // --px-good
    '#d29922', // --px-warn
    '#ff3b3b', // --px-danger
  ],
  other: '#7a5468', // --px-muted-2
  link: {
    color: '#3c0e25', // --px-line rgba(255,45,149,0.22) composited over --px-bg (see comment above)
    active: '#ff5cb0', // --px-accent-2
  },
  selection: '#ff5cb0', // --px-accent-2
  hover: '#ff2d95', // --px-accent
  pin: '#f7e6f0', // --px-text
  label: '#b98ca6', // --px-muted
  labelHalo: '#050505', // --px-bg
  dimOpacity: 0.14,
};
