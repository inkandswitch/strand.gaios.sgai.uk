import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import { createMemo } from "solid-js";

// Which draft has changes to a file that the other doesn't: ours (the
// checked-out draft), theirs (the compared one), or both.
export type Side = "ours" | "theirs" | "both";

/**
 * The checked-out draft compared with another, as the rows read it: a file
 * that differs is marked with whose changes it has, a folder with whose
 * changes are beneath it, and while comparing everything else is quieter.
 */
export type ChangeMarks = {
  side(url: AutomergeUrl): Side | undefined;
  comparing(): boolean;
};

// The compare provider's `compare:changes`. Without one above (outside a
// draft) nothing is marked.
type CompareChanges = {
  status: "off" | "loading" | "ready";
  files: Record<AutomergeUrl, Side>;
  folders: Record<AutomergeUrl, Side>;
};

const NONE: CompareChanges = { status: "off", files: {}, folders: {} };

export function useChangeMarks(element: HTMLElement): ChangeMarks {
  const changes = subscribe<CompareChanges>(element, { type: "compare:changes" }, NONE);
  const sides = createMemo(() => ({ ...changes().folders, ...changes().files }));
  return {
    side: (url) => sides()[url],
    comparing: () => changes().status === "ready",
  };
}
