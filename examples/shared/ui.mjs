/**
 * Example chrome — HUD, legend, controls.
 *
 * Example code, deliberately outside `src/`. The engine renders a graph; it does
 * not own a sidebar, a colour legend or an FPS readout, and if it did, every
 * consumer would inherit someone else's product decisions.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') Object.assign(node.style, v);
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Frame-timing readout.
 *
 * Shows sim and render separately because one number cannot tell you which half
 * is slow, and shows the 1% low because a mean of 60 with a stutter is not 60.
 */
export function makeHud(view) {
  const rows = {};
  const box = el('div', { class: 'hud' });
  for (const key of ['state', 'fps', '1% low', 'sim', 'render', 'nodes', 'links', 'labels', 'alpha']) {
    const value = el('span', { class: 'v' }, '—');
    rows[key] = value;
    box.appendChild(el('div', { class: 'row' }, [el('span', { class: 'k' }, key), value]));
  }
  let last = 0;
  function update(t) {
    if (t - last > 250) {
      last = t;
      const s = view.stats();
      const r = view.renderer.stats;
      // Say WHICH state the numbers describe. A settled graph skips the redraw
      // entirely, so 0.00 ms is the optimisation working, not a broken meter.
      rows['state'].textContent = view.simulation.settled ? 'settled · idle' : 'simulating';
      rows['fps'].textContent = s.fps.toFixed(1);
      rows['1% low'].textContent = s.low1.toFixed(1);
      rows['sim'].textContent = `${s.simMs.toFixed(2)} ms`;
      rows['render'].textContent = `${s.renderMs.toFixed(2)} ms`;
      rows['nodes'].textContent = `${r.nodesDrawn} / ${view.graph.nodeCount}`;
      rows['links'].textContent = `${r.linksDrawn} / ${view.graph.linkCount}`;
      rows['labels'].textContent = String(r.labelsDrawn);
      rows['alpha'].textContent = view.simulation.alpha.toFixed(4);
    }
    requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
  return box;
}

/**
 * Colour legend.
 *
 * Not optional decoration: three of the eight light-mode palette slots sit under
 * 3:1 against the surface, so colour is not permitted to be the only channel
 * carrying identity. The legend (plus the hover label) is that second channel.
 */
export function makeLegend(view, onToggle) {
  const box = el('div', { class: 'legend' });
  function rebuild() {
    box.textContent = '';
    for (const row of view.palette.legend(view.theme)) {
      const swatch = el('span', {
        class: 'swatch',
        style: { background: row.color },
      });
      const item = el('button', { class: 'legend-row', type: 'button' }, [
        swatch,
        el('span', { class: 'legend-label' }, row.label),
        el('span', { class: 'legend-count' }, String(row.count)),
      ]);
      if (onToggle) item.addEventListener('click', () => onToggle(row.label, item));
      box.appendChild(item);
    }
  }
  rebuild();
  return { box, rebuild };
}

export function control(label, node) {
  return el('label', { class: 'control' }, [el('span', { class: 'control-label' }, label), node]);
}

export function slider({ min, max, step, value, onInput }) {
  const out = el('span', { class: 'slider-value' }, String(value));
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    out.textContent = input.value;
    onInput(parseFloat(input.value));
  });
  return el('span', { class: 'slider' }, [input, out]);
}

export function button(label, onClick) {
  return el('button', { type: 'button', class: 'btn', onClick }, label);
}

export function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check' }, [input, el('span', {}, label)]);
}

/**
 * `BASE_CSS` used to hard-code the dark palette's own colours (`#1a1a19`,
 * `#898781`, …), so switching `view.theme` recoloured the canvas and left every
 * panel, border and label exactly where it was. Everything below reads from
 * six CSS custom properties instead, so `applyThemeChrome` (below) is the one
 * place a theme change has to touch. `--panel` and `--border` are not on the
 * `Theme` contract on purpose — the engine has no opinion about chrome — so
 * `color-mix()` derives every shade actually used (hover states, input
 * backgrounds, `kbd`) from the six base tokens at the point of use rather than
 * inventing more custom properties to keep in sync.
 */
export const BASE_CSS = `
  :root {
    color-scheme: dark;
    --bg: #1a1a19;
    --panel: #221f1e;
    --border: #383835;
    --ink: #ffffff;
    --ink-muted: #898781;
    --accent: #3987e5;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink-muted);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  #app { position: fixed; inset: 0; }
  .panel { position: absolute; top: 12px; left: 12px; width: 250px; max-height: calc(100% - 24px);
    overflow: auto; padding: 12px; border-radius: 10px; background: color-mix(in srgb, var(--panel) 93%, transparent);
    border: 1px solid var(--border); backdrop-filter: blur(6px); }
  .panel h1 { margin: 0 0 2px; font-size: 13px; color: var(--ink); letter-spacing: .01em; }
  .panel .sub { margin: 0 0 12px; font-size: 11px; color: var(--ink-muted); }
  .panel section { margin-bottom: 14px; }
  .panel h2 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase;
    letter-spacing: .09em; color: var(--ink-muted); font-weight: 600; }
  .hud { position: absolute; top: 12px; right: 12px; padding: 10px 12px; border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 93%, transparent); border: 1px solid var(--border);
    font-variant-numeric: tabular-nums; min-width: 168px; }
  .hud .row { display: flex; justify-content: space-between; gap: 14px; }
  .hud .k { color: var(--ink-muted); }
  .hud .v { color: var(--ink); }
  .legend { display: flex; flex-direction: column; gap: 1px; }
  .legend-row { display: flex; align-items: center; gap: 7px; width: 100%; padding: 3px 5px;
    background: none; border: 0; border-radius: 5px; color: inherit; font: inherit;
    cursor: pointer; text-align: left; }
  .legend-row:hover { background: color-mix(in srgb, var(--panel), var(--ink) 12%); }
  .legend-row[data-off="1"] { opacity: .35; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-count { color: var(--ink-muted); font-variant-numeric: tabular-nums; }
  .control { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-bottom: 6px; }
  .control-label { color: var(--ink-muted); }
  .slider { display: flex; align-items: center; gap: 7px; }
  .slider input { width: 96px; }
  .slider-value { color: var(--ink); font-variant-numeric: tabular-nums; min-width: 30px;
    text-align: right; }
  .btn { padding: 5px 9px; border-radius: 6px; border: 1px solid var(--border);
    background: color-mix(in srgb, var(--panel), var(--ink) 6%); color: var(--ink-muted);
    font: inherit; cursor: pointer; }
  .btn:hover { background: color-mix(in srgb, var(--panel), var(--ink) 16%); color: var(--ink); }
  .check { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; cursor: pointer; }
  input[type=search], select { width: 100%; padding: 5px 7px; border-radius: 6px;
    border: 1px solid var(--border); background: color-mix(in srgb, var(--bg), black 6%);
    color: var(--ink); font: inherit; }
  .hint { color: var(--ink-muted); font-size: 11px; line-height: 1.5; }
  kbd { background: color-mix(in srgb, var(--panel), var(--ink) 6%); border: 1px solid var(--border);
    border-bottom-width: 2px; border-radius: 4px; padding: 0 4px;
    font: 11px ui-monospace, monospace; color: var(--ink-muted); }
  .status { margin-top: 6px; color: var(--ink); font-variant-numeric: tabular-nums; }
  .physics-row { margin-bottom: 9px; }
  .physics-label { display: block; color: var(--ink-muted); margin-bottom: 3px; }
  .physics-control { display: flex; align-items: center; gap: 8px; }
  .physics-control input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent); }
  .physics-value { color: var(--ink); font-variant-numeric: tabular-nums;
    min-width: 40px; text-align: right; font-size: 12px; }
  .physics-reset { width: 100%; margin-top: 4px; }
`;

// ------------------------------------------------------------------ theming

function parseHex(hex) {
  let h = String(hex).trim();
  const m3 = /^#([0-9a-fA-F]{3})$/.exec(h);
  if (m3) h = '#' + [...m3[1]].map((c) => c + c).join('');
  const m = /^#([0-9a-fA-F]{6})/.exec(h); // an #rrggbbaa suffix is ignored, same call as themes/contract.ts
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Mix `hex` toward `target` by fraction `t` (0..1). This is the "small
 * documented lighten/darken helper" that derives panel/border chrome from a
 * theme — `Theme` has no panel colour and gaining one here would mean two
 * copies of a colour system to keep in sync, so the examples derive chrome
 * from colours the theme already has to supply (`background`, `ink.primary`).
 * Mixing toward `ink.primary` rather than plain white/black also means the
 * derived shade automatically goes the readable direction: `ink.primary` is
 * contract-guaranteed >= 4.5:1 against `background` (R2), so nudging toward it
 * can only move a panel/border AWAY from the background, never wash it out.
 */
function mix(hex, target, t) {
  const a = parseHex(hex);
  const b = parseHex(target);
  if (!a || !b) return hex; // unparsable — leave it rather than guess
  return toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}

/**
 * Drive the example chrome (panel/hud/border/text) from a `Theme` instead of
 * the hard-coded dark greys `BASE_CSS` shipped with before. Sets the six
 * custom properties on `:root`; every rule above reads them (or derives a
 * shade from them with `color-mix()`), so this is the only place that has to
 * know what changed.
 */
export function applyThemeChrome(theme) {
  const root = document.documentElement.style;
  root.setProperty('--bg', theme.background);
  root.setProperty('--panel', mix(theme.background, theme.ink.primary, 0.06));
  root.setProperty('--border', mix(theme.background, theme.ink.primary, 0.18));
  root.setProperty('--ink', theme.ink.primary);
  root.setProperty('--ink-muted', theme.ink.muted);
  root.setProperty('--accent', theme.palette[0]);
}

/**
 * Labelled, keyboard-reachable theme switcher — a `<select>` rather than the
 * old 2-state button, because there are three shipped themes now and a button
 * only ever offers "the other one".
 *
 * `redrawPolicy` defaults to `'on-change'`, so a settled graph skips the draw
 * on frames where nothing moved (see `src/graphView.ts`) — a theme swap on a
 * settled graph would silently do nothing without an explicit invalidation.
 * `GraphView#theme`'s setter already does that (`this.dirty = true`, same
 * mechanism `invalidate()` uses), so assigning `view.theme = t` here is
 * sufficient; calling `view.invalidate()` afterwards would just be a second,
 * redundant dirty flag.
 *
 * The choice persists to `localStorage` under `forcefield:theme:<page>` and is
 * restored on load, so a shared link keeps whatever theme the visitor picked
 * last time on that same page.
 */
export function themeSelect(view, themes, onChange) {
  const storageKey = `forcefield:theme:${location.pathname}`;
  const saved = localStorage.getItem(storageKey);
  const initial = themes.find((t) => t.name === saved) ?? view.theme;

  const select = el(
    'select',
    { 'aria-label': 'colour theme' },
    themes.map((t) => el('option', { value: t.name }, t.name)),
  );
  select.value = initial.name;

  function apply(theme) {
    view.theme = theme;
    applyThemeChrome(theme);
    onChange?.(theme);
    localStorage.setItem(storageKey, theme.name);
  }

  select.addEventListener('change', () => {
    const t = themes.find((th) => th.name === select.value);
    if (t) apply(t);
  });

  apply(initial); // also runs on first load, so the CSS vars match whatever `initial` turned out to be

  return control('theme', select);
}
