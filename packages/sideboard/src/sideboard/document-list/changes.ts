import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import { createMemo, createSelector } from "solid-js";

/**
 * What the checked-out draft changed, as the rows read it: a changed file is
 * marked, and with `onlyChanged` on, only changed files and the folders
 * holding them show.
 */
export type ChangeMarks = {
  changed(url: AutomergeUrl): boolean;
  holdsChanges(url: AutomergeUrl): boolean;
  onlyChanged(): boolean;
};

// The review provider's `review:changes`. Without one above (outside a draft)
// nothing is marked.
type ChangeView = {
  files: AutomergeUrl[];
  folders: AutomergeUrl[];
  onlyChanged: boolean;
};

const NONE: ChangeView = { files: [], folders: [], onlyChanged: false };

export function useChangeMarks(element: HTMLElement): ChangeMarks {
  const view = subscribe<ChangeView>(element, { type: "review:changes" }, NONE);
  const files = createMemo(() => new Set(view().files));
  const folders = createMemo(() => new Set(view().folders));
  return {
    changed: createSelector(files, (url: AutomergeUrl, set) => set.has(url)),
    holdsChanges: createSelector(folders, (url: AutomergeUrl, set) => set.has(url)),
    onlyChanged: () => view().onlyChanged,
  };
}
