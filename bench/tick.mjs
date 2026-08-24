#!/usr/bin/env node
/**
 * Headless simulation benchmark.
 *
 * Measures ONLY the physics — no canvas, no GPU, no browser. That is deliberate:
 * rendering performance depends on someone's graphics stack, but the simulation
 * is the part this engine actually owns, and its cost is a property of the
 * machine and the algorithm rather than of a driver.
 *
 * It also runs the same graph with `theta = 0`, which turns Barnes-Hut off and
 * makes the many-body step exactly O(n²). The ratio between the two columns is
 * the whole reason the quadtree exists, measured rather than asserted.
 *
 *   node bench/tick.mjs [--sizes 500,1651,2864,6000,12000] [--ticks 60]
 */

import { Graph } from '../dist/src/core/graph.js';
import { Simulation } from '../dist/src/core/simulation.js';
import { Rng } from '../dist/src/util/rng.js';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--(\S+)\s+(\S+)/g)
    .map((m) => [m[1], m[2]]),
);
const SIZES = (args.sizes ?? '500,1651,2864,6000,12000,25000').split(',').map(Number);
const TICKS = Number(args.ticks ?? 60);
const EXACT_LIMIT = Number(args['exact-limit'] ?? 6000);

function build(n, seed = 20260824) {
  const g = new Graph(seed);
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) {
    g.addNode({ id: `n${i}`, radius: 3 + rng.next() * 4 });
  }
  for (let i = 1; i < n; i++) g.addLink({ source: `n${Math.floor(rng.next() * i)}`, target: `n${i}` });
  for (let i = 0; i < n * 0.4; i++) {
    const a = Math.floor(rng.next() * n);
    const b = Math.floor(rng.next() * n);
    if (a !== b) {
      try {
        g.addLink({ source: `n${a}`, target: `n${b}`, weight: 0.3 + rng.next() * 0.7 });
      } catch {
        /* duplicate, ignore */
      }
    }
  }
  return g;
}

/** Median of per-tick milliseconds — a mean is hostage to one GC pause. */
function measure(g, theta, ticks) {
  const sim = new Simulation(g, { seed: 1 });
  sim.force('manyBody').theta = theta;
  sim.alphaTarget = 0.3; // keep it warm so no tick is skipped
  sim.alpha = 0.3;
  // Warm up the JIT before measuring.
  for (let i = 0; i < 10; i++) sim.tick(1);
  const samples = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    sim.tick(1);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const rows = [];
for (const n of SIZES) {
  const g1 = build(n);
  const links = g1.linkCount;
  const bh = measure(g1, 0.9, TICKS);
  const exact = n <= EXACT_LIMIT ? measure(build(n), 0, Math.min(TICKS, 20)) : null;
  rows.push({ n, links, bh, exact });
}

const pad = (s, w) => String(s).padStart(w);
console.log('');
console.log('forcefield — simulation cost per tick (median), no rendering');
console.log(`ticks sampled: ${TICKS} · node ${process.version} · ${process.platform}/${process.arch}`);
console.log('');
console.log(
  `${pad('nodes', 7)} ${pad('links', 7)} ${pad('barnes-hut', 12)} ${pad('ticks/s', 9)} ` +
    `${pad('exact O(n²)', 12)} ${pad('speedup', 8)} ${pad('ms/node·log n', 14)}`,
);
console.log('-'.repeat(76));
for (const r of rows) {
  const perUnit = (r.bh / (r.n * Math.log2(Math.max(2, r.n)))) * 1e6;
  console.log(
    `${pad(r.n, 7)} ${pad(r.links, 7)} ${pad(r.bh.toFixed(3) + ' ms', 12)} ` +
      `${pad((1000 / r.bh).toFixed(0), 9)} ` +
      `${pad(r.exact === null ? '—' : r.exact.toFixed(3) + ' ms', 12)} ` +
      `${pad(r.exact === null ? '—' : (r.exact / r.bh).toFixed(1) + '×', 8)} ` +
      `${pad(perUnit.toFixed(1) + ' ns', 14)}`,
  );
}
console.log('');
console.log(
  'The last column is time per node per log₂(n). Flat means the implementation is',
);
console.log('genuinely O(n log n); a column that climbs means it is not.');
console.log('');
