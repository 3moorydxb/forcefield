/**
 * Reference live-physics panel — four sliders that move the graph as you drag them.
 *
 * EXAMPLE CODE, deliberately outside `src/`. The engine exposes `setForces()`;
 * it does not own a sidebar. Each consumer renders its own panel in its own
 * theme — copy this file and restyle it, that is what it is for.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SLIDERS ARE NOT LINEAR
 *
 * The control names, ranges and defaults here match the graph settings in
 * Obsidian, because that is the interface these graphs are read against and a
 * control that shares a name should share a feel.
 *
 * The important part is not the numbers, it is the CURVE. That UI stores the
 * slider POSITION and maps it through an exponential before it reaches the
 * physics. Skipping that and wiring the position straight to a force is the
 * single easiest way to get sliders that look identical and feel wrong: on a
 * linear control the bottom tenth of the travel covers a 10x change and the top
 * half covers 2x, so all the useful adjustment hides in a few pixels on the left.
 *
 * `expoResponse` in the engine is that curve. `expoPosition` is its inverse, used
 * to place a handle from a stored value.
 *
 *   position 0..1  --expoResponse-->  physics 0..1  --calibrate-->  engine units
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CALIBRATION, AND WHY IT IS A COINCIDENCE WORTH KNOWING
 *
 * Those two systems turn out to describe the SAME layout at different scales:
 *
 *     link distance   250 / 44  = 5.68x
 *     repulsion      1000 / 30  = 33.3x        and 5.68^2 = 32.3
 *
 * For a spring/repulsion equilibrium, scaling every length by s requires scaling
 * repulsion by s^2 to keep the same shape. 33.3 vs 32.3 is a 3% discrepancy, so
 * the two default configurations are the same graph — one just measured in bigger
 * units. That is what makes an honest mapping possible at all, and it is why the
 * table below lands each default exactly on the engine's own tuned default
 * rather than on a number someone eyeballed.
 */

import { expoResponse, expoPosition, DEFAULT_PHYSICS } from '../../dist/index.js';
import { el } from './ui.mjs';

/**
 * The four controls. `min`/`max`/`step` and `default` are the slider-space
 * values; `toEngine` converts a slider position into engine units.
 *
 * The three strength defaults land on the engine's own tuned values; the
 * distance default is deliberately the reference UI's 250 rather than the
 * engine's 44, and `repelForce` is scaled by 33.3 to pair with it. Distance and
 * repulsion are only meaningful together — see the note on `repelForce`.
 */
export const CONTROLS = [
  {
    key: 'centerForce',
    label: 'Center force',
    min: 0,
    max: 1,
    step: 'any',
    default: 0.5187132489703118, // the position whose response is 0.1
    decimals: 2,
    // response(0.51871) = 0.1 = DEFAULT_PHYSICS.centerForce
    toEngine: (pos) => expoResponse(pos),
    toPosition: (engine) => expoPosition(engine),
    hint: 'pull toward the middle',
  },
  {
    key: 'repelForce',
    label: 'Repel force',
    min: 0,
    max: 20,
    step: 'any',
    default: 10,
    decimals: 2,
    // Cubic, matching the reference UI, then scaled into engine units.
    //
    // 🔴 The scale factor is NOT optional and getting it wrong is invisible in
    // code review but obvious side by side. The reference UI's repulsion at
    // slider 10 is 10^3 = 1000 of ITS units; the engine's per-node charge is 30,
    // so the equivalent multiplier is 1000/30 = 33.33.
    //
    // The trap: the engine's own defaults are (distance 44, repel 1) and the
    // reference UI's are (distance 250, repel 1000). Those describe the SAME
    // layout only as a PAIR — 250/44 = 5.68 and 5.68^2 = 32.3 ~= 33.3. Calibrate
    // each control independently against the engine default and you end up at
    // distance 250 with repel 1, which is 33x too little repulsion for that
    // length: the graph collapses into an overlapping ball. Caught by putting
    // the two renders next to each other, not by reading the code.
    toEngine: (pos) => Math.pow(pos / 10, 3) * (1000 / 30),
    toPosition: (engine) => 10 * Math.cbrt(Math.max(0, engine) / (1000 / 30)),
    hint: 'node-to-node push',
  },
  {
    key: 'linkForce',
    label: 'Link force',
    min: 0,
    max: 1,
    step: 'any',
    default: 1,
    decimals: 2,
    // response(1) = 1, scaled to the engine's 0.7 default. Capped under 1 by
    // PHYSICS_LIMITS anyway — the integrator rings above ~0.9.
    toEngine: (pos) => expoResponse(pos) * 0.7,
    toPosition: (engine) => expoPosition(Math.min(1, engine / 0.7)),
    hint: 'attraction along an edge',
  },
  {
    key: 'linkDistance',
    label: 'Link distance',
    min: 30,
    max: 500,
    step: 1,
    default: 250,
    decimals: 0,
    // The only one that is a straight pass-through: it is already a length.
    // 250 slider units is 250 world units; the engine's default of 44 is the
    // same layout drawn smaller, and the camera fits either.
    toEngine: (pos) => pos,
    toPosition: (engine) => engine,
    hint: 'rest length of an edge',
  },
];

const STORAGE_KEY = 'graph-engine:physics';

/** Slider positions -> engine `PhysicsSettings`. */
export function positionsToSettings(positions) {
  const out = {};
  for (const c of CONTROLS) out[c.key] = c.toEngine(positions[c.key]);
  return out;
}

/** The default slider positions. */
export function defaultPositions() {
  const out = {};
  for (const c of CONTROLS) out[c.key] = c.default;
  return out;
}

function loadPositions(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultPositions();
    const saved = JSON.parse(raw);
    const out = defaultPositions();
    for (const c of CONTROLS) {
      const v = saved[c.key];
      // Validate every restored value. A stored blob from an older version is
      // exactly how a NaN or an out-of-range number gets into the physics
      // without anyone touching a slider.
      if (typeof v === 'number' && Number.isFinite(v)) {
        out[c.key] = Math.min(c.max, Math.max(c.min, v));
      }
    }
    return out;
  } catch {
    return defaultPositions();
  }
}

/**
 * Build the panel.
 *
 * @param view   a GraphView
 * @param opts   { storageKey, onChange }
 * @returns { box, reset, positions }
 */
export function makePhysicsPanel(view, opts = {}) {
  const storageKey = opts.storageKey ?? STORAGE_KEY;
  const positions = loadPositions(storageKey);

  const box = el('div', { class: 'physics' });
  const rows = {};

  function push(reheat = 0.3) {
    view.setForces(positionsToSettings(positions), { reheat });
    opts.onChange?.(positions, view.getForces());
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(positions));
    } catch {
      /* private mode, quota — the graph still works, persistence just doesn't */
    }
  }

  function render(c) {
    const value = el('span', { class: 'physics-value' }, positions[c.key].toFixed(c.decimals));
    const input = el('input', {
      type: 'range',
      min: String(c.min),
      max: String(c.max),
      step: String(c.step),
      'aria-label': c.label,
    });
    input.value = String(positions[c.key]);

    // `input` fires continuously during the drag — that IS the live behaviour.
    input.addEventListener('input', () => {
      positions[c.key] = parseFloat(input.value);
      value.textContent = positions[c.key].toFixed(c.decimals);
      push();
    });

    // Hold the temperature for the whole POINTER gesture rather than relying on
    // the per-event reheat. Refcounted in the engine, so this composes with a
    // node drag happening at the same time.
    //
    // 🔴 `holding` is not defensive clutter — without it this leaks. Pressing on
    // an unfocused slider fires BOTH `pointerdown` AND `focus`, so binding hold
    // to both takes two holds and `pointerup` returns only one. The count never
    // reaches zero, alphaTarget stays at 0.3, and the graph runs full physics and
    // redraws forever until focus happens to move elsewhere — the exact opposite
    // of "an idle graph costs nothing".
    //
    // Keyboard is deliberately NOT held: each arrow key fires `input`, and the
    // one-shot reheat inside setForces is right for a discrete step. It warms,
    // moves, and settles.
    let holding = false;
    const begin = () => {
      if (holding) return;
      holding = true;
      view.simulation.hold(0.3);
    };
    const end = () => {
      if (!holding) return;
      holding = false;
      view.simulation.release();
      save();
    };
    input.addEventListener('pointerdown', begin);
    input.addEventListener('pointerup', end);
    input.addEventListener('pointercancel', end);
    // Persist a keyboard change too, without touching the hold count.
    input.addEventListener('change', save);

    rows[c.key] = { input, value };

    return el('div', { class: 'physics-row' }, [
      el('label', { class: 'physics-label', title: c.hint }, c.label),
      el('div', { class: 'physics-control' }, [value, input]),
    ]);
  }

  for (const c of CONTROLS) box.appendChild(render(c));

  const resetBtn = el(
    'button',
    { type: 'button', class: 'btn physics-reset', onClick: () => reset() },
    'reset to defaults',
  );
  box.appendChild(resetBtn);

  function reset() {
    Object.assign(positions, defaultPositions());
    for (const c of CONTROLS) {
      rows[c.key].input.value = String(positions[c.key]);
      rows[c.key].value.textContent = positions[c.key].toFixed(c.decimals);
    }
    save();
    push(0.6);
  }

  // Apply whatever we restored, without waking the graph — the caller is about
  // to start the simulation anyway and a reheat here would fight the initial fit.
  view.setForces(positionsToSettings(positions), { reheat: 0 });

  return { box, reset, positions };
}

export const PHYSICS_CSS = `
  .physics-row { margin-bottom: 9px; }
  .physics-label { display: block; color: #c3c2b7; margin-bottom: 3px; }
  .physics-control { display: flex; align-items: center; gap: 8px; }
  .physics-control input[type=range] { flex: 1; min-width: 0; accent-color: #3987e5; }
  .physics-value { color: #fff; font-variant-numeric: tabular-nums;
    min-width: 40px; text-align: right; font-size: 12px; }
  .physics-reset { width: 100%; margin-top: 4px; }
`;

export { DEFAULT_PHYSICS };
