#!/usr/bin/env node
/**
 * Adapter: a folder of markdown notes → a graph-engine JSON file.
 *
 * THIS IS AN EXAMPLE, NOT PART OF THE ENGINE. It lives under `examples/` on
 * purpose: it knows about markdown, wikilinks and frontmatter, and the engine
 * must not. Every convention it reads is a flag with a default, so it is not
 * bound to any one vault — point `--link-field` at whatever field names a
 * parent, or write your own twenty-line adapter and skip this.
 *
 * It reads notes that name their parent with a wikilink, e.g.
 *
 *     Up: [[Some Parent]]
 *     `type: pillar`
 *
 * Usage:
 *   node markdown-tree.mjs --vault <dir> --out <file.graph.json> \
 *        [--link-field Up] [--type-pattern "`type:\\s*([^`]+)`"] \
 *        [--positions <persisted-positions.json>] [--import-pins]
 *        [--exclude .obsidian,.git]
 *
 * Nothing about the source path is written into the output — ids are relative to
 * `--vault`, so the result carries no machine-specific anything and the file it
 * produces is `.gitignore`d anyway.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const vault = args.vault;
const out = args.out;
if (!vault || !out) {
  console.error('usage: markdown-tree.mjs --vault <dir> --out <file.graph.json> [options]');
  process.exit(2);
}

const linkField = args['link-field'] ?? 'Up';
const typePattern = new RegExp(args['type-pattern'] ?? '`type:\\s*([^`]+)`');
const exclude = new Set((args.exclude ?? '.obsidian,.git,.trash,node_modules').split(','));
const linkRe = new RegExp(`^${escapeRe(linkField)}:\\s*\\[\\[([^\\]|#]+)`, 'm');

// ---------------------------------------------------------------- walk files

const files = [];
walk(vault);
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (exclude.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (entry.endsWith('.md')) files.push(p);
  }
}

// --------------------------------------------------------------- parse notes

const nodes = [];
const byName = new Map(); // note basename (no extension) -> id
const duplicates = new Set(); // basenames a wikilink cannot disambiguate
const parentOf = new Map();
let withParent = 0;
let withType = 0;

for (const file of files) {
  const id = relative(vault, file).split(sep).join('/');
  const name = basename(file, '.md');
  const text = readFileSync(file, 'utf8');

  const parent = linkRe.exec(text)?.[1]?.trim();
  const type = typePattern.exec(text)?.[1]?.trim() ?? inferType(id);
  if (parent) withParent++;
  if (typePattern.test(text)) withType++;

  nodes.push({ id, label: name, type });
  // Last writer wins on a duplicate basename; reported below rather than hidden.
  if (byName.has(name)) duplicates.add(name);
  byName.set(name, id);
  if (parent) parentOf.set(id, parent);
}

const duplicatesArr = [...duplicates];

// ------------------------------------------------------------------- links

const links = [];
let unresolved = 0;
for (const [childId, parentName] of parentOf) {
  const parentId = byName.get(parentName);
  if (!parentId || parentId === childId) {
    unresolved++;
    continue;
  }
  // source = parent, target = child, so `branch(id, 'out')` is "descendants".
  links.push({ source: parentId, target: childId, weight: 1, kind: linkField });
}

// --------------------------------------------------------- saved positions

let positioned = 0;
let stale = 0;
let pinsImported = 0;
const importPins = args['import-pins'] === true;
const unpositioned = [];
if (args.positions) {
  const saved = JSON.parse(readFileSync(args.positions, 'utf8'));
  const pos = new Map();
  for (const p of saved.nodePositions ?? []) pos.set(p.id, p);
  const pinned = new Set(saved.pinnedNodes ?? []);
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (p) {
      n.x = p.x;
      n.y = p.y;
      positioned++;
    } else {
      // Named, not silently defaulted. A consumer that treats saved coordinates
      // as the whole answer needs to know which nodes the file does not cover.
      unpositioned.push(n.id);
    }
    // Pins are OPT-IN. A coordinate-persistence plugin pins every node as its
    // storage mechanism, so importing those wholesale would nail the entire
    // graph down and turn the simulation into a coordinate replay — the exact
    // thing this engine exists not to be. Pass --import-pins if the pins in your
    // source really are user intent.
    if (importPins && pinned.has(n.id)) {
      n.pinned = true;
      pinsImported++;
    }
  }
  // Stale = a saved position whose note id no longer exists. Compared on the
  // SAME key the join uses, so `used + stale` reconciles with the file's count
  // instead of being two numbers measured different ways.
  const ids = new Set(nodes.map((n) => n.id));
  for (const id of pos.keys()) if (!ids.has(id)) stale++;
}

// Radius by degree, so hubs read as hubs. A presentation choice made by the
// ADAPTER, not by the engine — the engine has no opinion about what is important.
const degree = new Map();
for (const l of links) {
  degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
  degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
}
for (const n of nodes) {
  const d = degree.get(n.id) ?? 0;
  n.radius = Math.min(14, 3 + Math.sqrt(d) * 1.5);
}

writeFileSync(
  out,
  JSON.stringify({
    nodes,
    links,
    meta: {
      source: 'markdown-tree adapter',
      linkField,
      unresolvedParents: unresolved,
      duplicateBasenames: duplicatesArr,
      // The ids the saved-position file does not cover. The example seeds these
      // from their neighbours; without the list it would have no way to tell a
      // saved coordinate from a randomly generated one.
      unpositioned,
    },
  }),
);

console.log(
  [
    `notes                ${nodes.length}`,
    `with a ${linkField}: field      ${withParent}`,
    `with an inline type  ${withType}`,
    `links resolved       ${links.length}`,
    `parent not found     ${unresolved}`,
    `duplicate basenames  ${duplicatesArr.length}${
      duplicatesArr.length ? ` (${duplicatesArr.slice(0, 5).join(', ')}…)` : ''
    }`,
    args.positions ? `saved positions used  ${positioned}` : null,
    args.positions
      ? `pins imported        ${pinsImported}${importPins ? '' : ' (--import-pins is off)'}`
      : null,
    args.positions ? `saved positions stale ${stale}` : null,
    args.positions
      ? `notes with NO saved position ${nodes.length - positioned} — these must be laid out by the simulation`
      : null,
    `types                ${new Set(nodes.map((n) => n.type)).size}`,
    `written              ${out}`,
  ]
    .filter(Boolean)
    .join('\n'),
);

// -------------------------------------------------------------------- utils

function inferType(id) {
  // Fallback: the first path segment. Better than one undifferentiated blob and
  // it makes the "no type field at all" case still useful.
  const seg = id.split('/');
  return seg.length > 1 ? seg[0] : '(root)';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else {
      o[key] = next;
      i++;
    }
  }
  return o;
}
