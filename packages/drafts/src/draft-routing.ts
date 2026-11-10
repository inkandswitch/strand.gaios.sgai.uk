import type { AutomergeUrl } from "@automerge/automerge-repo/slim";

export type DraftRouterOptions = {
  // The draft to start on, from the provider's `draft` attribute.
  initial: AutomergeUrl | null;
  checkedOut: () => AutomergeUrl | null;
  select: (draftUrl: AutomergeUrl | null) => void;
};

export type DraftRouter = {
  updateAvailableDrafts: (draftUrls: readonly AutomergeUrl[]) => void;
  selectionChanged: () => void;
};

// Checks out the starting draft once it shows up among the root's live
// drafts, unless something else was selected first. A checked-out draft that
// goes away (merged or deleted, here or by a peer) falls back to main. Only
// one that was listed and then isn't counts as gone: a draft forked a moment
// ago may not be listed yet.
export function createDraftRouter(options: DraftRouterOptions): DraftRouter {
  let pending = options.initial;
  let available = new Set<AutomergeUrl>();

  return {
    updateAvailableDrafts(draftUrls) {
      const previous = available;
      available = new Set(draftUrls);
      if (pending && available.has(pending)) {
        const target = pending;
        pending = null;
        if (options.checkedOut() !== target) options.select(target);
        return;
      }
      const selected = options.checkedOut();
      if (selected && previous.has(selected) && !available.has(selected)) {
        options.select(null);
      }
    },
    selectionChanged() {
      if (pending && options.checkedOut() !== pending) pending = null;
    },
  };
}
