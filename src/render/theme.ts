import type { Graph } from '../core/graph.js';
import type { Theme } from '../../themes/contract.js';

/**
 * The pure types and the flagship themes now live in `themes/` — the whole
 * folder is the contribution surface, and a contributor adding a theme should
 * not have to read the engine to do it. This is a one-directional dependency:
 * `src/` imports from `themes/`, `themes/` never imports from `src/`.
 *
 * Everything re-exported here keeps every existing internal import path
 * (`./render/theme.js`) resolving exactly as it did before the split — nothing
 * that already imports from this file needs to change.
 */
export type { Theme, NodeStyle, LinkStyle, NodeShape } from '../../themes/contract.js';
export { darkTheme, lightTheme } from '../../themes/index.js';

/**
 * Maps a consumer's `type` strings onto palette slots.
 *
 * Two rules, both of which exist because breaking them makes a graph lie:
 *
 * 1. **Fixed order, never cycled.** Types are assigned slots once, by descending
 *    frequency then alphabetically, over the WHOLE graph. A type that does not
 *    fit in eight gets `other` — a ninth generated hue would sit somewhere
 *    arbitrary in colour space and read as a category it is not.
 * 2. **Colour follows the entity, not its rank.** Because assignment is computed
 *    from the whole graph, filtering down to three types does not repaint them.
 *    A colour that moves when you filter teaches the reader the wrong thing.
 */
export class TypePalette {
  private slot = new Map<string, number>();
  private counts = new Map<string, number>();

  /** Assign slots from every type present in `graph`. Call once after loading. */
  assignFrom(graph: Graph): this {
    this.counts.clear();
    for (let i = 0; i < graph.nodeCount; i++) {
      const t = graph.types[i]!;
      this.counts.set(t, (this.counts.get(t) ?? 0) + 1);
    }
    const ordered = [...this.counts.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    this.slot.clear();
    ordered.forEach(([t], i) => this.slot.set(t, i));
    return this;
  }

  /** Assign an explicit order — for when the consumer knows better than frequency. */
  assignExplicit(types: string[]): this {
    this.slot.clear();
    types.forEach((t, i) => this.slot.set(t, i));
    return this;
  }

  /** `0..7` for a slotted type, `-1` for everything else (drawn as `other`). */
  slotOf(type: string, size = 8): number {
    const s = this.slot.get(type);
    return s === undefined || s >= size ? -1 : s;
  }

  colorOf(type: string, theme: Theme): string {
    const s = this.slotOf(type, theme.palette.length);
    return s < 0 ? theme.other : theme.palette[s]!;
  }

  /**
   * Legend entries, in slot order, with the overflow folded into one `Other`
   * row that names how many types it hides — a legend that silently omits
   * eleven categories is worse than no legend.
   */
  legend(theme: Theme): { label: string; color: string; count: number }[] {
    const size = theme.palette.length;
    const rows: { label: string; color: string; count: number }[] = [];
    let otherCount = 0;
    let otherTypes = 0;
    for (const [type, s] of this.slot) {
      const c = this.counts.get(type) ?? 0;
      if (s < size) rows.push({ label: type || '(untyped)', color: theme.palette[s]!, count: c });
      else {
        otherCount += c;
        otherTypes++;
      }
    }
    rows.sort((a, b) => b.count - a.count);
    if (otherTypes > 0) {
      rows.push({
        label: `Other (${otherTypes} type${otherTypes === 1 ? '' : 's'})`,
        color: theme.other,
        count: otherCount,
      });
    }
    return rows;
  }
}
