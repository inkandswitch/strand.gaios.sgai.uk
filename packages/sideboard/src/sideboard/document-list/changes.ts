import { parseAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo/slim";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import { createMemo } from "solid-js";

// How a file differs. Compared with another draft: both drafts have it and
// it `differs`, or only `ours` (the checked-out draft) or `theirs` has it.
// Merged into another draft, what the merge does to that draft's version:
// `added`, `removed`, `changed`, or changed where `both` drafts edited it.
export type Mark =
  | "differs"
  | "ours"
  | "theirs"
  | "added"
  | "removed"
  | "changed"
  | "both";

// A file or folder the checked-out draft doesn't have, linked from `parent`.
export type Ghost = {
  url: AutomergeUrl;
  name: string;
  type: string | undefined;
  folder: boolean;
  parent: AutomergeUrl;
};

/**
 * The checked-out draft compared with another, or merged into one, as the
 * rows read it: a file that differs is marked with how, a folder with what's
 * beneath it, what only the other draft has shows as ghosts, and everything
 * else is quieter.
 */
export type ChangeMarks = {
  mark(url: AutomergeUrl): Mark | undefined;
  comparing(): boolean;
  ghostsIn(folder: AutomergeUrl): Ghost[];
};

// The compare provider's `compare:changes`. Without one above (outside a
// draft) nothing is marked.
type CompareChanges = {
  status: "off" | "loading" | "ready";
  files: Record<AutomergeUrl, Mark>;
  folders: Record<AutomergeUrl, Mark>;
  ghosts?: Ghost[];
};

const NONE: CompareChanges = { status: "off", files: {}, folders: {}, ghosts: [] };

export function useChangeMarks(element: HTMLElement): ChangeMarks {
  const changes = subscribe<CompareChanges>(element, { type: "compare:changes" }, NONE);
  const marks = createMemo(() => ({ ...changes().folders, ...changes().files }));
  const ghosts = createMemo(() => {
    const byParent = new Map<string, Ghost[]>();
    for (const ghost of changes().ghosts ?? []) {
      const key = documentOf(ghost.parent);
      byParent.set(key, [...(byParent.get(key) ?? []), ghost]);
    }
    return byParent;
  });
  return {
    mark: (url) => marks()[url],
    comparing: () => changes().status === "ready",
    ghostsIn: (folder) => ghosts().get(documentOf(folder)) ?? [],
  };
}

function documentOf(url: AutomergeUrl): string {
  return parseAutomergeUrl(url).documentId;
}
