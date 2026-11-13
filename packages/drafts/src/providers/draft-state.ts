import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";

import type {
  DraftDoc,
  DraftEntry,
  DraftSelection,
  HasDrafts,
} from "../draft-types.js";
import { createDraftRouter } from "../draft-routing.js";

const MAIN = "Main";
const DRAFT = "Draft";

export type DraftStateOptions = {
  repo: Repo;
  // The draft root: the folder whose tree the drafts cover.
  docUrl: AutomergeUrl;
  // The draft to start on, once it's confirmed as one of the root's.
  initial: AutomergeUrl | null;
  selection: () => DraftSelection;
  // Check out a draft (null for main) at its live heads.
  select: (draftUrl: AutomergeUrl | null) => void;
};

// Main's url and every draft's entry, main first.
export type DraftList = {
  main: AutomergeUrl;
  drafts: DraftEntry[];
};

export type DraftState = {
  subscribeList: (respond: (list: DraftList) => void) => () => void;
  list: () => DraftList;
  // The root's handle, once it has loaded.
  root: () => Promise<DocHandle<HasDrafts>>;
  selectionChanged: () => void;
  dispose: () => void;
};

// The drafts of one root: main plus one entry per draft that hasn't been
// merged, depth first, so a fork lists directly beneath the draft it was
// forked off.
//
// The link from a root to its drafts is `@patchwork.mainDraftUrl` → the main
// draft, whose `drafts` roots the tree; each `DraftDoc` may have its own
// sub-drafts via `DraftDoc.drafts`. Looking at a root writes nothing: the main
// draft is made by the first fork (or by renaming main).
export function createDraftState(options: DraftStateOptions): DraftState {
  const { repo, docUrl, selection } = options;

  let rootHandle: DocHandle<HasDrafts> | null = null;
  let mainDraftHandle: DocHandle<DraftDoc> | null = null;
  const trackedDrafts = new Map<AutomergeUrl, DocHandle<DraftDoc>>();
  const listSubscribers = new Set<(list: DraftList) => void>();
  let orderedDraftUrls: AutomergeUrl[] = [];
  let draftList: DraftList = {
    main: docUrl,
    drafts: [{ url: docUrl, name: MAIN, parent: null, depth: 0 }],
  };

  const router = createDraftRouter({
    initial: options.initial,
    checkedOut: () => selection().checkedOut,
    select: options.select,
  });

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  // A tracked draft changing can mean its sub-draft list moved (needs a
  // rewalk) or its name changed (needs a list recompute), so do both.
  const onTrackedChange = () => {
    scheduleRewalk();
    reconcile();
  };
  const onRootChange = () => {
    const url = rootHandle?.doc()?.["@patchwork"]?.mainDraftUrl ?? null;
    if (url !== (mainDraftHandle?.url ?? null)) scheduleRewalk();
  };

  const ready = (async () => {
    const handle = await repo.find<HasDrafts>(docUrl);
    if (disposed) return handle;
    rootHandle = handle;
    handle.on("change", onRootChange);
    scheduleRewalk();
    return handle;
  })();
  ready.catch((err) => {
    console.error(`[drafts] failed to load the draft root:`, err);
  });

  return {
    subscribeList(respond) {
      respond(draftList);
      listSubscribers.add(respond);
      return () => {
        listSubscribers.delete(respond);
      };
    },
    list: () => draftList,
    root: () => ready,
    selectionChanged() {
      if (disposed) return;
      router.selectionChanged();
    },
    dispose,
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    rootHandle?.off("change", onRootChange);
    mainDraftHandle?.off("change", onTrackedChange);
    for (const handle of trackedDrafts.values()) {
      handle.off("change", onTrackedChange);
    }
    rootHandle = null;
    mainDraftHandle = null;
    trackedDrafts.clear();
    listSubscribers.clear();
  }

  function scheduleRewalk(): void {
    if (disposed || !rootHandle) return;
    if (rewalkInFlight) {
      rewalkPending = true;
      return;
    }
    rewalkInFlight = true;
    void (async () => {
      try {
        const mainDraft = await trackMainDraft();
        if (disposed) return;
        const roots = (mainDraft?.doc()?.drafts ?? []).filter(
          isValidAutomergeUrl
        );
        const allDrafts = await collectAllDrafts(
          repo,
          roots,
          trackedDrafts,
          onTrackedChange,
          () => disposed
        );
        if (disposed) return;
        const reachable = new Set(allDrafts);
        for (const [url, handle] of trackedDrafts) {
          if (reachable.has(url)) continue;
          handle.off("change", onTrackedChange);
          trackedDrafts.delete(url);
        }
        orderedDraftUrls = allDrafts;
        router.updateAvailableDrafts(
          allDrafts.filter(
            (url) => trackedDrafts.get(url)?.doc()?.mergedAt === undefined
          )
        );
      } catch (err) {
        console.error("[drafts] rewalk failed:", err);
      } finally {
        rewalkInFlight = false;
        reconcile();
        if (rewalkPending) {
          rewalkPending = false;
          scheduleRewalk();
        }
      }
    })();
  }

  // Push the list to subscribers when it actually changed.
  function reconcile(): void {
    if (disposed) return;
    const next = computeList();
    if (draftListsEqual(draftList, next)) return;
    draftList = next;
    for (const respond of listSubscribers) respond(next);
  }

  function computeList(): DraftList {
    const main = mainDraftHandle?.url ?? docUrl;
    const mainName = mainDraftHandle?.doc()?.name ?? MAIN;
    const entries: DraftEntry[] = [
      { url: main, name: mainName, parent: null, depth: 0 },
    ];
    const depths = new Map<AutomergeUrl, number>([[main, 0]]);
    for (const url of orderedDraftUrls) {
      const doc = trackedDrafts.get(url)?.doc();
      if (!doc || doc.mergedAt !== undefined) continue;
      const parent = effectiveParent(doc.parent) ?? main;
      const known = depths.has(parent) ? parent : main;
      const depth = (depths.get(known) ?? 0) + 1;
      depths.set(url, depth);
      entries.push({ url, name: doc.name ?? DRAFT, parent: known, depth });
    }
    return { main, drafts: entries };
  }

  // The nearest ancestor that hasn't been merged. Merging re-parents
  // children, but a concurrent merge on another peer can still orphan one.
  // Unknown urls (the main draft) pass through as they are.
  function effectiveParent(
    parentUrl: AutomergeUrl | undefined
  ): AutomergeUrl | null {
    const seen = new Set<AutomergeUrl>();
    let cursor = parentUrl ?? null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const doc = trackedDrafts.get(cursor)?.doc();
      if (!doc || doc.mergedAt === undefined) return cursor;
      cursor = doc.parent ?? null;
    }
    return cursor;
  }

  // Resolve and start tracking the root's main draft, if it has one.
  async function trackMainDraft(): Promise<DocHandle<DraftDoc> | null> {
    if (!rootHandle) return null;
    const url = rootHandle.doc()?.["@patchwork"]?.mainDraftUrl;
    if (!url || !isValidAutomergeUrl(url)) return null;
    if (mainDraftHandle?.url === url) return mainDraftHandle;
    mainDraftHandle?.off("change", onTrackedChange);
    const handle = await repo.find<DraftDoc>(url);
    if (disposed) return null;
    mainDraftHandle = handle;
    handle.on("change", onTrackedChange);
    return handle;
  }
}

// Depth-first pre-order, so a fork lists directly beneath its parent.
async function collectAllDrafts(
  repo: Repo,
  roots: readonly AutomergeUrl[],
  tracked: Map<AutomergeUrl, DocHandle<DraftDoc>>,
  onNewChange: () => void,
  isDisposed: () => boolean
): Promise<AutomergeUrl[]> {
  const visited = new Set<AutomergeUrl>();
  const order: AutomergeUrl[] = [];
  const queue: AutomergeUrl[] = [...roots];
  while (queue.length) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    order.push(url);

    let handle = tracked.get(url);
    if (!handle) {
      handle = await repo.find<DraftDoc>(url);
      if (isDisposed()) return order;
      tracked.set(url, handle);
      handle.on("change", onNewChange);
    }
    const drafts = (handle.doc()?.drafts ?? []).filter(isValidAutomergeUrl);
    queue.unshift(...drafts);
  }
  return order;
}

function draftListsEqual(a: DraftList, b: DraftList): boolean {
  if (a.main !== b.main || a.drafts.length !== b.drafts.length) return false;
  return a.drafts.every((draft, i) => entriesEqual(draft, b.drafts[i]));
}

function entriesEqual(a: DraftEntry, b: DraftEntry): boolean {
  return (
    a.url === b.url &&
    a.parent === b.parent &&
    a.depth === b.depth &&
    a.name === b.name
  );
}
