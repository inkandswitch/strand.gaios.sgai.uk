import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";

import {
  DRAFT_NAME,
  isDraftDoc,
  isMergeDoc,
  type DraftDoc,
  type DraftEntry,
  type HasWorkspace,
  type MergeDoc,
  type MergeEntry,
  type Overlay,
  type Workspace,
} from "../overlay-types.js";

export type Lists = { drafts: DraftEntry[]; merges: MergeEntry[] };

export type OverlayList = {
  lists(): Lists;
  subscribe(listener: () => void): () => void;
  // Whether `overlay` is main or listed: a draft, a pull request, or the
  // preview checked out (or about to be).
  has(overlay: Overlay): boolean;
  // `url` as a merge that can be checked out though it may not be listed:
  // one whose source and target are main or listed drafts. Loads it to tell.
  preview(url: AutomergeUrl): Promise<MergeEntry | undefined>;
  draft(url: AutomergeUrl): DraftEntry | undefined;
  merge(url: AutomergeUrl): MergeEntry | undefined;
  // The root's handle, once it has loaded.
  root(): Promise<DocHandle<HasWorkspace>>;
  // The checkout moved, so a pending start no longer applies.
  selectionChanged(): void;
  dispose(): void;
};

// The overlays of one root: every draft in its workspace, every pull request
// whose source and target are main or a listed draft, and the preview checked
// out, if one is. Looking at a root writes nothing: the workspace is made
// with the first overlay.
//
// It also keeps the checkout on the list: the overlay the provider started
// on is checked out once it shows up, unless something else was first, and a
// checked-out overlay that goes away (merged or deleted, here or by a peer)
// falls back to main. Only one that was listed and then isn't counts as gone:
// one made a moment ago may not be listed yet.
export function createOverlayList(options: {
  repo: Repo;
  rootUrl: AutomergeUrl;
  // The overlay to start on, once it's listed.
  initial: Overlay;
  checkedOut: () => Overlay;
  select: (overlay: Overlay) => void;
}): OverlayList {
  const { repo, rootUrl } = options;
  const tracked = new Map<AutomergeUrl, DocHandle<DraftDoc | MergeDoc>>();
  const listeners = new Set<() => void>();
  let rootHandle: DocHandle<HasWorkspace> | null = null;
  let workspace: DocHandle<Workspace> | null = null;
  let lists: Lists = { drafts: [], merges: [] };
  let listed = new Set<AutomergeUrl>();
  let pending = options.initial;
  // Merges nothing lists that were asked about: listed while checked out.
  const previews = new Set<AutomergeUrl>();
  let disposed = false;

  const update = () => {
    if (disposed) return;
    void track().then(reconcile);
  };

  const ready = (async () => {
    const handle = await repo.find<HasWorkspace>(rootUrl);
    if (disposed) return handle;
    rootHandle = handle;
    handle.on("change", update);
    update();
    return handle;
  })();
  ready.catch((err) => console.error("[drafts] failed to load the root:", err));

  return {
    lists: () => lists,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    has: (overlay) => overlay === null || listed.has(overlay),
    async preview(url) {
      previews.add(url);
      await ready;
      await track();
      return previewEntry(url);
    },
    draft: (url) => lists.drafts.find((entry) => entry.url === url),
    merge: (url) => lists.merges.find((entry) => entry.url === url),
    root: () => ready,
    selectionChanged() {
      if (pending && options.checkedOut() !== pending) pending = null;
      // A preview is listed only while it's checked out.
      reconcile();
    },
    dispose() {
      disposed = true;
      rootHandle?.off("change", update);
      workspace?.off("change", update);
      for (const handle of tracked.values()) handle.off("change", update);
      tracked.clear();
      listeners.clear();
    },
  };

  // Load and follow the workspace, and every overlay on it, and every draft an
  // overlay names that's no longer listed, to find a listed ancestor.
  async function track(): Promise<void> {
    const workspaceUrl = rootHandle?.doc()?.["@patchwork"]?.workspaceUrl;
    if (workspaceUrl && isValidAutomergeUrl(workspaceUrl) && workspace?.url !== workspaceUrl) {
      workspace?.off("change", update);
      workspace = await repo.find<Workspace>(workspaceUrl);
      if (disposed) return;
      workspace.on("change", update);
    }
    const doc = workspace?.doc();
    if (pending) previews.add(pending);
    const wanted = [...(doc?.drafts ?? []), ...(doc?.merges ?? []), ...previews];
    for (let i = 0; i < wanted.length; i++) {
      const url = wanted[i];
      if (!isValidAutomergeUrl(url)) continue;
      let handle = tracked.get(url);
      if (!handle) {
        try {
          handle = await repo.find<DraftDoc | MergeDoc>(url);
        } catch (err) {
          console.warn("[drafts] failed to load overlay:", url, err);
          continue;
        }
        if (disposed) return;
        tracked.set(url, handle);
        handle.on("change", update);
      }
      const overlay = handle.doc();
      const parent = isDraftDoc(overlay) ? overlay.parent : null;
      if (parent && !wanted.includes(parent)) wanted.push(parent);
    }
  }

  function reconcile(): void {
    if (disposed) return;
    const next = compute();
    if (sameLists(lists, next)) return;
    const previous = listed;
    lists = next;
    listed = new Set([...next.drafts, ...next.merges].map((entry) => entry.url));
    route(previous);
    for (const listener of [...listeners]) listener();
  }

  function compute(): Lists {
    const doc = workspace?.doc();
    const draftUrls = new Set(
      (doc?.drafts ?? []).filter((url) => isDraftDoc(tracked.get(url)?.doc()))
    );
    const drafts: DraftEntry[] = [...draftUrls].map((url) => {
      const draft = tracked.get(url)!.doc() as DraftDoc;
      return { url, name: draft.name ?? DRAFT_NAME, parent: listedParent(draft.parent, draftUrls) };
    });
    const live = (input: AutomergeUrl | null) => input === null || draftUrls.has(input);
    const merges: MergeEntry[] = [];
    for (const url of doc?.merges ?? []) {
      const merge = tracked.get(url)?.doc();
      if (!isMergeDoc(merge)) continue;
      if (!live(merge.source) || !live(merge.target) || merge.source === merge.target) continue;
      merges.push({ url, source: merge.source, target: merge.target, published: true });
    }
    for (const url of [options.checkedOut(), pending]) {
      if (!url || merges.some((entry) => entry.url === url)) continue;
      const entry = previewEntry(url, draftUrls);
      if (entry) merges.push(entry);
    }
    return { drafts, merges };
  }

  // `url` as a preview, if it's a merge of main or listed drafts.
  function previewEntry(
    url: AutomergeUrl,
    draftUrls = new Set(lists.drafts.map((entry) => entry.url))
  ): MergeEntry | undefined {
    const merge = tracked.get(url)?.doc();
    if (!isMergeDoc(merge)) return undefined;
    const live = (input: AutomergeUrl | null) => input === null || draftUrls.has(input);
    if (!live(merge.source) || !live(merge.target) || merge.source === merge.target) return undefined;
    const published = (workspace?.doc()?.merges ?? []).includes(url);
    return { url, source: merge.source, target: merge.target, published };
  }

  // The nearest draft up from `parent` that's listed; null for main.
  function listedParent(parent: AutomergeUrl | null, draftUrls: Set<AutomergeUrl>): AutomergeUrl | null {
    const seen = new Set<AutomergeUrl>();
    let cursor = parent;
    while (cursor && !draftUrls.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const doc = tracked.get(cursor)?.doc();
      cursor = isDraftDoc(doc) ? doc.parent : null;
    }
    return cursor;
  }

  function route(previous: Set<AutomergeUrl>): void {
    if (pending && listed.has(pending)) {
      const target = pending;
      pending = null;
      if (options.checkedOut() !== target) options.select(target);
      return;
    }
    const selected = options.checkedOut();
    if (selected && previous.has(selected) && !listed.has(selected)) options.select(null);
  }
}

function sameLists(a: Lists, b: Lists): boolean {
  return (
    a.drafts.length === b.drafts.length &&
    a.merges.length === b.merges.length &&
    a.drafts.every(
      (draft, i) =>
        draft.url === b.drafts[i].url &&
        draft.name === b.drafts[i].name &&
        draft.parent === b.drafts[i].parent
    ) &&
    a.merges.every(
      (merge, i) =>
        merge.url === b.merges[i].url &&
        merge.source === b.merges[i].source &&
        merge.target === b.merges[i].target &&
        merge.published === b.merges[i].published
    )
  );
}
