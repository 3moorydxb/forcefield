# Adapters

**These are examples, not part of the engine.** They know about file formats, wikilinks and
frontmatter; `src/` must not. Each one is a short script — the point is that writing your own is
easy, not that these cover every case.

The engine's input format is plain JSON:

```json
{
  "nodes": [{ "id": "a", "label": "A", "type": "person", "x": 0, "y": 0, "radius": 5 }],
  "links": [{ "source": "a", "target": "b", "weight": 0.8, "kind": "knows" }]
}
```

Only `id` is required on a node, and only `source`/`target` on a link.

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
