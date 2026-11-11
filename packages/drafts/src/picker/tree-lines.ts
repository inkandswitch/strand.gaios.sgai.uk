import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

import type { Entry } from "./picker.js";

/**
 * One indent column of a row: the line down it, split at the row's middle,
 * and in the row's own column the tick across to its name. A part on the way
 * from main to the checked-out draft is `path`.
 */
export type Cell = { up: Line; down: Line; tick: Line };
export type Line = "none" | "plain" | "path";

/**
 * The connectors in front of each row of `entries`, which list main and then
 * every draft depth first. A draft hangs off a line down from its parent that
 * runs on to the parent's last draft.
 */
export function treeLines(entries: Entry[], checkedOut: AutomergeUrl | null): Cell[][] {
  const index = new Map(entries.map((entry, i) => [entry.url, i]));
  const lastChild = new Map<AutomergeUrl | null, AutomergeUrl | null>();
  for (const entry of entries) {
    if (entry.depth > 0) lastChild.set(entry.parent, entry.url);
  }
  const pathChild = pathChildren(entries, checkedOut);

  return entries.map((entry) => {
    const cells: Cell[] = [];
    let below: Entry | undefined = entry;
    for (let level = entry.depth - 1; level >= 0 && below; level--) {
      const parent: AutomergeUrl | null = below.parent;
      const own = below === entry;
      const continues = lastChild.get(parent) !== below.url;
      const onPath = pathChild.get(parent);
      const above =
        onPath !== undefined && index.get(below.url)! < index.get(onPath)!;
      const reaches = own && onPath === below.url;
      cells.unshift({
        up: own || continues ? (above || reaches ? "path" : "plain") : "none",
        down: continues ? (above ? "path" : "plain") : "none",
        tick: own ? (reaches ? "path" : "plain") : "none",
      });
      below = entries[index.get(parent) ?? 0];
      if (below.depth !== level) break;
    }
    return cells;
  });
}

// For each draft on the way down to the checked-out one, the draft beneath it
// that's next on the way.
function pathChildren(
  entries: Entry[],
  checkedOut: AutomergeUrl | null
): Map<AutomergeUrl | null, AutomergeUrl | null> {
  const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
  const next = new Map<AutomergeUrl | null, AutomergeUrl | null>();
  let entry = byUrl.get(checkedOut);
  while (entry && entry.depth > 0) {
    next.set(entry.parent, entry.url);
    entry = byUrl.get(entry.parent);
  }
  return next;
}
