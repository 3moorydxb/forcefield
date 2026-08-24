# Adapters

**These are examples, not part of the engine.** The engine is content-agnostic on purpose —
`NodeSpec.type` is *"consumer's own category string, never interpreted here"* and `NodeSpec.data`
is *"consumer payload, never read here"* (see `src/core/graph.ts`). That is the whole product: the
engine plugs into anything, because it refuses to know what anything means. An adapter is where the
domain knowledge lives — markdown, wikilinks, frontmatter, import statements, whatever your source
is — and each one here is a short script, on purpose. The point is that writing your own is easy,
not that these cover every case.

---

## The contract

The engine ingests plain JSON, `{ nodes, links }`. Every field below is taken from the real
`NodeSpec` / `LinkSpec` types in `src/core/graph.ts` — nothing here is aspirational.

```json
{
  "nodes": [{ "id": "a", "label": "A", "type": "person", "x": 0, "y": 0, "radius": 5 }],
  "links": [{ "source": "a", "target": "b", "weight": 0.8, "kind": "knows" }]
}
```

**Node** — only `id` is required.

| field | type | meaning |
|---|---|---|
| `id` | `string` | **required.** Identity. Everything else is looked up by this. |
| `type` | `string?` | your category string. See "will never interpret" below. |
| `label` | `string?` | text the renderer draws. Falls back to `id`. |
| `data` | `unknown?` | your payload. See "will never interpret" below. |
| `x`, `y` | `number?` | starting coordinates. Omit and the node is seeded near its neighbours (or on a small disc around the origin if it has none yet). |
| `radius` | `number?` | drawing + collision radius, world units. **Must be `> 0` if given** — a zero or negative radius throws rather than silently clamping. Defaults to `4`. |
| `mass` | `number?` | inertia; heavier nodes move less for the same force. Must be `> 0` if given. Defaults to `1`. |
| `charge` | `number?` | repulsion charge. Negative repels (the default, `-30`), positive attracts. |
| `pinned` | `boolean?` | a pinned node does not integrate, but stays in the quadtree and on both ends of its springs — it goes on pushing and pulling everything else. |

**Link** — `source` and `target` are required, and must both name nodes that already exist. A link
to an id that is not in the file is dropped silently when the graph is loaded — no phantom node
gets invented on your behalf, and the drop is not reported by the engine itself, so an adapter that
cares (both of these do) counts and reports its own unresolved links rather than relying on the
engine to notice.

| field | type | meaning |
|---|---|---|
| `source`, `target` | `string` | **required.** Node ids. |
| `weight` | `number?` | confidence/strength in `[0, 1]` (clamped). Scales the spring, and the stroke if the renderer wants it. Defaults to `1`. |
| `distance` | `number?` | preferred rest length, world units. Must be `> 0` if given. Falls back to the link force's own default. |
| `kind` | `string?` | your edge category. See "will never interpret" below. |
| `data` | `unknown?` | your payload, same rule as a node's. |

### What the engine WILL interpret

`id` (identity — the join key for everything), `source` / `target` (topology — what connects to
what), `x` / `y` (starting coordinates), `radius` (collision radius and hit target), `weight` (link
rest length / spring strength), `pinned` (excluded from integration), `label` (the literal text the
renderer draws).

### What the engine will NEVER interpret

`type` is your category string. The engine uses it for exactly two things it can do without
knowing what the string means: assign it a palette slot, and let you filter/branch by it. It has no
built-in vocabulary of types — `"person"`, `"folder"`, `"npm-package"` and `"pillar"` are all just
strings to it.

`data` is your payload, on both a node and a link. Never read by the engine. It exists purely so an
adapter (or the thing consuming the render, e.g. a click handler) has somewhere to carry whatever it
needs.

`kind` on a link is the same idea as `type` on a node — yours, opaque, never interpreted.

**If the engine ever learns what a markdown note or an import statement is, that is the bug.**
Domain knowledge belongs in `examples/`, never in `src/`.

---

## How to write an adapter, in five steps

1. **Walk or query your source** for the things that should become nodes.
2. **Assign each one a stable `id`** — something that survives a re-run (a path, a slug, a primary
   key). The id is the only thing a link can reference.
3. **Decide `type`** — the one categorical fact about a node that is worth colouring by. Pick ONE
   axis (a person's role, a file's top-level folder, a note's first path segment) rather than
   trying to encode several facts into it.
4. **Find the relationships** and emit them as `{ source, target }` — only for ids you already
   emitted a node for.
5. **Report what you could not resolve**, instead of writing a file that looks complete. A dangling
   reference, a duplicate identity, an item your walk had to skip — say so in the console output, in
   `meta`, or both. This is the difference between an adapter you can trust and one you have to
   double-check by hand every time.

A ~20-line worked example — a CSV of `id,parent,category` rows:

```js
import { readFileSync, writeFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').slice(1); // skip header
const nodes = [];
const links = [];
const ids = new Set();

for (const row of rows) {
  const [id, parent, category] = row.split(',');
  nodes.push({ id, type: category });
  ids.add(id);
  if (parent) links.push({ source: parent, target: id }); // parent -> child
}

const unresolved = links.filter((l) => !ids.has(l.source));
writeFileSync(process.argv[3], JSON.stringify({ nodes, links: links.filter((l) => ids.has(l.source)) }));
console.log(`${nodes.length} nodes, ${links.length - unresolved.length} links, ${unresolved.length} unresolved`);
```

That is the whole pattern. `markdown-tree.mjs` and `codebase.mjs` below are the same five steps with
more source-specific detail (wikilinks, frontmatter, an actual import-resolution tool) and more
options, not a different shape.

### The rule

Adapters live in `examples/`. They may take on their own dependencies freely — a markdown parser, a
CSV library, `dependency-cruiser` — because none of that is the engine's problem. `src/` stays at
zero dependencies, `package.json` `dependencies` stays absent, and if a consumer's concept (a note,
an import, a person) ever shows up in `src/`, that is a bug in this repo, not a feature request.

---

## `markdown-tree.mjs`

Turns a folder of markdown notes into a graph, where each note names its parent with a wikilink.

```bash
node examples/adapters/markdown-tree.mjs \
  --vault /path/to/notes \
  --out   examples/tree/mine.graph.json \
  --positions /path/to/saved-positions.json     # optional
```

Then open `/examples/tree/?data=mine.graph.json`.

| flag | default | what it does |
|---|---|---|
| `--vault` | required | folder to walk |
| `--out` | required | output JSON |
| `--link-field` | `Up` | the field naming the parent: `Up: [[Some Parent]]` |
| `--type-pattern` | `` `type:\s*([^`]+)` `` | regex whose first group is the node type |
| `--positions` | — | a `{nodePositions:[{id,x,y}], pinnedNodes:[id]}` file |
| `--import-pins` | **off** | import `pinnedNodes` as actual pins |
| `--exclude` | `.obsidian,.git,.trash,node_modules` | directory names to skip |

### Two things it does deliberately

**`--import-pins` is off by default.** A coordinate-persistence plugin pins every node as its
storage mechanism. Importing those wholesale nails the entire graph down and turns the simulation
into a coordinate replay — the exact thing this engine exists not to be. Turn it on only if the
pins in your source are genuinely user intent.

**It reports what it could not do**, rather than quietly producing a file that looks complete:
notes with no parent field, parents that resolve to nothing, duplicate basenames a wikilink cannot
disambiguate, saved positions that no longer match any note, and — the important one — **how many
notes the position file does not cover.** Those ids go into `meta.unpositioned` so the example can
seed them from their neighbours and let the simulation place them.

On the hierarchy this was developed against, that number was **1,289 of 2,864 (45%)**. A consumer
that treated the saved coordinates as the whole answer would have dropped nearly half the graph on
the origin.

### Output is portable

Ids are relative to `--vault`, so nothing about the source path ends up in the file. The generated
`*.graph.json` is `.gitignore`d regardless — it is someone's notes, not sample data.

---

## `synthetic-vault.mjs`

Writes a synthetic markdown vault to disk — real `.md` files, in nested folders, using exactly the
`Up: [[Parent]]` / `` `type: ...` `` conventions `markdown-tree.mjs` reads by default. It exists so
the hosted `/examples/tree/` demo has a data source that is not someone's real notes: run this, then
run `markdown-tree.mjs` over what it wrote, and the demo (and the 2,864-node benchmark) become
reproducible by anyone, from nothing.

```bash
node examples/adapters/synthetic-vault.mjs --out /tmp/vault --notes 2864 --seed 20260824 --types 37
node examples/adapters/markdown-tree.mjs --vault /tmp/vault --out examples/tree/demo.graph.json
```

| flag | default | what it does |
|---|---|---|
| `--out` | required | directory to write the vault into |
| `--notes` | `2864` | how many notes to generate |
| `--seed` | `20260824` | seed for the engine's own `Rng` (`src/util/rng.ts`) |
| `--types` | `37` | how many distinct `type:` tags to draw from |
| `--force` | off | allow writing into a non-empty `--out` |

Every choice — which words become titles, which note attaches to which parent, which type each note
gets — comes from the engine's seeded `Rng`. Same seed and counts produce a byte-identical vault
every time; verified by diffing two independent runs. Names come from small, neutral,
built-in word lists (geography and natural-science vocabulary): nothing personal, no real project
names, nothing recognisable, and it never reads any directory on this machine to produce them.

Parents are chosen by preferential attachment — an existing note that already has more children is
more likely to gain another one — which is what produces a heavy tail (a handful of hub notes,
most notes with one child or none) instead of an unrealistically flat tree. Depth is capped at 6.

It refuses to write into a non-empty `--out` unless `--force` is passed, and never deletes anything
either way — re-running with a smaller `--notes` count on the same directory leaves whatever the
previous run wrote that this run didn't overwrite.

---

## `codebase.mjs`

Turns a TypeScript/JavaScript codebase into an import graph: files become nodes, imports become
links. It is the second adapter, proof that "a folder of markdown notes" is not the only shape this
pattern fits — same five steps, a completely different source.

**Scope: TypeScript and JavaScript only.** "Any codebase" would be a later claim; this is the first
one.

It does not hand-roll an import parser. It shells out to
[dependency-cruiser](https://github.com/sverweij/dependency-cruiser) (also MIT) via `npx --yes` and
reads its JSON — import/require/re-export/dynamic-import/path-alias resolution is a solved, tested
problem, and duplicating a worse copy of it here would be exactly what this example set argues
against.

```bash
node examples/adapters/codebase.mjs --dir src --out /tmp/codebase.graph.json
node examples/adapters/codebase.mjs --input depcruise-report.json --out /tmp/codebase.graph.json
```

| flag | default | what it does |
|---|---|---|
| `--dir` | — | folder to cruise (runs `npx --yes dependency-cruiser@latest` for you) |
| `--input` | — | a dependency-cruiser JSON report produced separately (offline / CI use) |
| `--out` | required | output JSON |
| `--include-external` | **off** | give `node_modules` packages their own nodes |

Exactly one of `--dir` / `--input` is expected. `--input` exists so the cruise step and the graph
step can be different jobs — in CI, or with no network at all.

**`--include-external` is off by default.** A package that 200 files import becomes a hub that says
nothing about the codebase's own shape — it's a fact about npm, not about your code. Pass the flag
if you want those nodes anyway; they're typed `external:<package-name>` since they have no directory
of their own to be typed by.

**Mapping:** node id = the repo-relative path dependency-cruiser reports; label = the basename; type
= the top-level directory **relative to `--dir`** (so cruising `--dir src` types nodes `core`,
`render`, `interaction`, `util`, … — the actual areas — rather than uniformly `src`, which is what
you'd get from the raw path); radius by degree, same presentation choice `markdown-tree.mjs` makes.
Link `kind` is `local` / `npm` / `core` / `type-only`, reduced from dependency-cruiser's own
(possibly multi-valued) `dependencyTypes`.

**It reports what it could not do:** modules dependency-cruiser could not resolve (with examples,
not just a count), circular dependencies, orphan modules (no dependents and no dependencies), and
how many external dependencies were excluded. It never writes a file that looks complete when parts
of the cruise were not clean.

### The TypeScript gotcha in `--dir`

dependency-cruiser only parses `.ts` if it can `require('typescript')` from **its own** install
location — and `npx --yes` installs into an isolated cache with no relation to your project's
`node_modules`. Run a plain `npx --yes dependency-cruiser@latest` against a TypeScript codebase and
it reports `modules: []` — no error, just nothing. This adapter works around it by pointing
`NODE_PATH` at `<your project root>/node_modules` (found by walking up from `--dir` looking for a
`package.json`) before spawning `npx`, so a `typescript` your project already has installed becomes
visible to the cruise. If your project has no local `typescript`, `.ts` still will not resolve —
that is `--dir`'s honest limit, not a bug in this adapter, and it is exactly what `--input` is
for: cruise once, wherever `typescript` is actually available, save the JSON, feed it in here.

### Verified against this repo's own `src/`

```
modules cruised       27
nodes written         27
links written         85
could not resolve     0
circular dependencies 0
orphan modules        0
external excluded     0 (--include-external is off)
types                 6
written               /tmp/forcefield-codebase.graph.json
```

Six types — `core`, `render`, `interaction`, `util`, `themes`, and `(root)` for the two files
(`index.ts`, `graphView.ts`) that sit directly in `src/` — exactly the areas the repo actually has.
