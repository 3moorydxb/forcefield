#!/usr/bin/env node
/**
 * Adapter: TypeScript/JavaScript source → an import graph.
 *
 * THIS IS AN EXAMPLE, NOT PART OF THE ENGINE. It knows about modules, imports
 * and `node_modules` — the engine must not. It exists as the second adapter,
 * proof that "a folder of markdown notes" is not the only shape this pattern
 * fits: files become nodes, imports become links, same as notes and wikilinks.
 *
 * SCOPE: TypeScript and JavaScript only (whatever dependency-cruiser and its
 * installed transpilers can parse). "Any codebase" is a later claim; this is
 * the first one.
 *
 * It does NOT hand-roll an import parser. It shells out to dependency-cruiser
 * (https://github.com/sverweij/dependency-cruiser, also MIT) and reads its
 * JSON. Getting `import`/`require`/re-export/dynamic-import/path-alias
 * resolution right is its own hard problem, already solved, already tested —
 * duplicating it here would be exactly the kind of second, worse copy this
 * whole example set argues against.
 *
 * Usage:
 *   node codebase.mjs --dir <path> --out <file.graph.json> [--include-external]
 *   node codebase.mjs --input <depcruise.json> --out <file.graph.json> [--include-external]
 *
 * `--input` reads a dependency-cruiser JSON report produced separately (e.g. in
 * CI, where the cruise step and the graph-build step are different jobs, or
 * offline, with no network at all). `--dir` runs the cruise itself, via
 * `npx --yes dependency-cruiser@latest`.
 *
 * A NOTE ON `--dir` AND TYPESCRIPT: dependency-cruiser only parses `.ts` if it
 * can `require('typescript')` from ITS OWN install location, and `npx --yes`
 * installs into an isolated cache with no relation to your project's
 * `node_modules` — so a plain `npx --yes dependency-cruiser@latest` against a
 * TypeScript codebase silently cruises zero modules, no error, just an empty
 * `modules: []`. This script works around that the same way dependency-cruiser
 * itself documents for its plugin transpilers: it points `NODE_PATH` at
 * `<dir's project root>/node_modules` (walking up from `--dir` looking for one)
 * before spawning `npx`, so a `typescript` your project already has installed
 * becomes visible to the cruise. If your project has no local `typescript`,
 * `.ts` files still will not resolve — that is `--dir`'s honest limit, not a
 * bug in this adapter.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HELP =
  'usage: codebase.mjs --dir <path> --out <file.graph.json> [--include-external]\n' +
  '       codebase.mjs --input <depcruise.json> --out <file.graph.json> [--include-external]\n' +
  'scope: TypeScript and JavaScript only.';

const args = parseArgs(process.argv.slice(2));
const dir = args.dir;
const inputFile = args.input;
const out = args.out;
if (args.help || (!dir && !inputFile) || !out) {
  console.error(HELP);
  process.exit(args.help ? 0 : 2);
}
const includeExternal = args['include-external'] === true;

// ------------------------------------------------------------- get the data

let report;
if (inputFile) {
  if (dir) console.error('both --dir and --input given — using --input, --dir ignored.');
  report = JSON.parse(readFileSync(inputFile, 'utf8'));
} else {
  const projectRoot = findProjectRoot(dir) ?? resolve(dir);
  const nodePath = join(projectRoot, 'node_modules');
  const env = { ...process.env };
  if (existsSync(nodePath)) {
    env.NODE_PATH = env.NODE_PATH ? `${nodePath}${pathSep()}${env.NODE_PATH}` : nodePath;
  }
  const result = spawnSync(
    'npx',
    ['--yes', 'dependency-cruiser@latest', '--no-config', '--ts-pre-compilation-deps', '--output-type', 'json', dir],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 128, env },
  );
  if (result.error) {
    console.error(`could not run dependency-cruiser (npx): ${result.error.message}`);
    console.error('if this is a network error, this --dir run is UNVERIFIED — use --input with a depcruise JSON produced offline instead.');
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`dependency-cruiser exited ${result.status}:\n${result.stderr}`);
    process.exit(1);
  }
  report = JSON.parse(result.stdout);
}

const modules = report.modules ?? [];
if (modules.length === 0) {
  console.error(
    'dependency-cruiser reported zero modules. For a TypeScript --dir this usually means it could ' +
      "not require('typescript') — see the note in this file's header. Nothing was written.",
  );
  process.exit(1);
}

// ------------------------------------------------------------ build nodes

const nodes = [];
const nodeIndex = new Map();
let externalExcluded = 0;

// dependency-cruiser reports every `source` relative to the cruise's own
// baseDir (its cwd), not relative to `--dir`. Cruising `--dir src` therefore
// makes every reported path start with `src/...` — so "top-level directory"
// of the RAW path is uniformly "src" and colours nothing. Strip the `--dir`
// prefix first, so the type is the folder one level below the thing the user
// actually pointed at (`core`, `render`, `interaction`, `util`, …), which is
// the split that is actually informative. `--input` has no `--dir` to strip
// against, so it falls back to the raw top segment.
const dirPrefix = dir ? normalizeDirPrefix(dir) : null;

for (const m of modules) {
  nodeIndex.set(m.source, nodes.length);
  nodes.push({ id: m.source, label: basenameOf(m.source), type: topDir(m.source, dirPrefix), data: { orphan: !!m.orphan } });
}

// ------------------------------------------------------------ build links

const links = [];
let couldNotResolveCount = 0;
const couldNotResolveExamples = [];
let circularCount = 0;

for (const m of modules) {
  for (const d of m.dependencies ?? []) {
    if (d.couldNotResolve) {
      couldNotResolveCount++;
      if (couldNotResolveExamples.length < 10) couldNotResolveExamples.push(`${m.source} -> ${d.module}`);
      continue; // no resolved target, so no honest node to link to
    }
    if (d.circular) circularCount++;

    const targetId = d.resolved;
    const kind = classifyKind(d.dependencyTypes ?? []);
    const isExternal = kind === 'npm';

    if (isExternal && !includeExternal) {
      externalExcluded++;
      continue;
    }

    if (isExternal && !nodeIndex.has(targetId)) {
      // A package that 200 files import becomes a hub that says nothing about
      // the codebase's own shape — that is the reason --include-external
      // defaults off. When it IS on, the external node is typed by its
      // package name, not by a directory, since it has none of its own here.
      nodeIndex.set(targetId, nodes.length);
      nodes.push({ id: targetId, label: packageNameOf(targetId), type: `external:${packageNameOf(targetId)}` });
    }
    if (!nodeIndex.has(targetId)) continue; // defensive: an unresolved target we did not expect

    links.push({ source: m.source, target: targetId, kind, weight: 1 });
  }
}

// Orphans: dependency-cruiser already flags them per-module (no deps in, no
// deps out). Reported, not silently dropped from the count the way a graph
// with no incident links would otherwise hide them.
const orphanCount = modules.filter((m) => m.orphan).length;

// Radius by degree — same presentation choice as markdown-tree.mjs: a
// hub reads as a hub. The engine has no opinion on this; the adapter does.
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
      source: 'codebase adapter',
      couldNotResolve: couldNotResolveCount,
      couldNotResolveExamples,
      circularDependencies: circularCount,
      orphans: orphanCount,
      externalExcluded,
      includeExternal,
    },
  }),
);

console.log(
  [
    `modules cruised       ${modules.length}`,
    `nodes written         ${nodes.length}`,
    `links written         ${links.length}`,
    `could not resolve     ${couldNotResolveCount}${
      couldNotResolveCount ? ` (e.g. ${couldNotResolveExamples.slice(0, 3).join(', ')}${couldNotResolveCount > 3 ? '…' : ''})` : ''
    }`,
    `circular dependencies ${circularCount}`,
    `orphan modules        ${orphanCount}`,
    `external excluded     ${externalExcluded}${includeExternal ? ' (--include-external is on, so this should be 0)' : ' (--include-external is off)'}`,
    `types                 ${new Set(nodes.map((n) => n.type)).size}`,
    `written               ${out}`,
  ].join('\n'),
);

// -------------------------------------------------------------------- utils

function classifyKind(types) {
  // dependencyTypes can carry several tags at once (e.g. ['local','import']).
  // Reduced to the one axis the README documents: local / npm / core /
  // type-only, most-specific-first — a type-only import is the interesting
  // fact about an edge even when it also happens to be local or npm.
  if (types.includes('type-only')) return 'type-only';
  if (types.some((t) => t.startsWith('npm'))) return 'npm';
  if (types.includes('core')) return 'core';
  if (types.includes('local')) return 'local';
  return 'other';
}

function basenameOf(p) {
  const seg = p.split('/');
  return seg[seg.length - 1];
}

function topDir(p, dirPrefix) {
  let rel = p;
  if (dirPrefix && (rel === dirPrefix || rel.startsWith(`${dirPrefix}/`))) {
    rel = rel.slice(dirPrefix.length).replace(/^\//, '');
  }
  const seg = rel.split('/');
  return seg.length > 1 ? seg[0] : '(root)';
}

function normalizeDirPrefix(d) {
  return d.replace(/^\.\//, '').replace(/\/+$/, '');
}

function packageNameOf(resolvedPath) {
  const m = resolvedPath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return m ? m[1] : 'external';
}

function findProjectRoot(startDir) {
  let cur = resolve(startDir);
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(cur, 'package.json'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function pathSep() {
  return process.platform === 'win32' ? ';' : ':';
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
