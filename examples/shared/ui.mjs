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

export const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #1a1a19; color: #c3c2b7;
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  #app { position: fixed; inset: 0; }
  .panel { position: absolute; top: 12px; left: 12px; width: 250px; max-height: calc(100% - 24px);
    overflow: auto; padding: 12px; border-radius: 10px; background: #21211fee;
    border: 1px solid #383835; backdrop-filter: blur(6px); }
  .panel h1 { margin: 0 0 2px; font-size: 13px; color: #fff; letter-spacing: .01em; }
  .panel .sub { margin: 0 0 12px; font-size: 11px; color: #898781; }
  .panel section { margin-bottom: 14px; }
  .panel h2 { margin: 0 0 6px; font-size: 10px; text-transform: uppercase;
    letter-spacing: .09em; color: #898781; font-weight: 600; }
  .hud { position: absolute; top: 12px; right: 12px; padding: 10px 12px; border-radius: 10px;
    background: #21211fee; border: 1px solid #383835; font-variant-numeric: tabular-nums;
    min-width: 168px; }
  .hud .row { display: flex; justify-content: space-between; gap: 14px; }
  .hud .k { color: #898781; }
  .hud .v { color: #fff; }
  .legend { display: flex; flex-direction: column; gap: 1px; }
  .legend-row { display: flex; align-items: center; gap: 7px; width: 100%; padding: 3px 5px;
    background: none; border: 0; border-radius: 5px; color: inherit; font: inherit;
    cursor: pointer; text-align: left; }
  .legend-row:hover { background: #2c2c2a; }
  .legend-row[data-off="1"] { opacity: .35; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
  .legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-count { color: #898781; font-variant-numeric: tabular-nums; }
  .control { display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-bottom: 6px; }
  .control-label { color: #898781; }
  .slider { display: flex; align-items: center; gap: 7px; }
  .slider input { width: 96px; }
  .slider-value { color: #fff; font-variant-numeric: tabular-nums; min-width: 30px;
    text-align: right; }
  .btn { padding: 5px 9px; border-radius: 6px; border: 1px solid #45453f; background: #2c2c2a;
    color: #c3c2b7; font: inherit; cursor: pointer; }
  .btn:hover { background: #383835; color: #fff; }
  .check { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; cursor: pointer; }
  input[type=search], select { width: 100%; padding: 5px 7px; border-radius: 6px;
    border: 1px solid #45453f; background: #131312; color: #fff; font: inherit; }
  .hint { color: #898781; font-size: 11px; line-height: 1.5; }
  kbd { background: #2c2c2a; border: 1px solid #45453f; border-bottom-width: 2px;
    border-radius: 4px; padding: 0 4px; font: 11px ui-monospace, monospace; color: #c3c2b7; }
  .status { margin-top: 6px; color: #fff; font-variant-numeric: tabular-nums; }
  .physics-row { margin-bottom: 9px; }
  .physics-label { display: block; color: #898781; margin-bottom: 3px; }
  .physics-control { display: flex; align-items: center; gap: 8px; }
  .physics-control input[type=range] { flex: 1; min-width: 0; accent-color: #3987e5; }
  .physics-value { color: #fff; font-variant-numeric: tabular-nums;
    min-width: 40px; text-align: right; font-size: 12px; }
  .physics-reset { width: 100%; margin-top: 4px; }
`;
