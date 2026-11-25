import { Automerge } from "@automerge/automerge-repo/slim";
import {
  encodeHeads,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";

import { createdAt, groupRows, rowsOf, timeOfChange, type Point, type Row } from "../history.js";
import type { OverlayRepo } from "../overlay-repo.js";
import type { DraftDoc, HistoryEntry, Overlay } from "../overlay-types.js";
import { isDraftDoc } from "../overlay-types.js";

// History is worked out again this long after something in it last changed.
const HISTORY_DEBOUNCE_MS = 300;

export type OverlayHistory = {
  /** `overlay`'s history, the newest entry first. */
  entries(overlay: Overlay): Promise<HistoryEntry[]>;
  /** Calls `listener` whenever `overlay`'s history may have moved. */
  watch(overlay: Overlay, listener: () => void): () => void;
  /** The point `at` names in `overlay`'s history, if it's there. */
  point(overlay: Overlay, at: string): Promise<Point | undefined>;
};

/**
 * Each overlay's history, from its members' changes (see `HistoryEntry`).
 * Main's is every change to its members. A draft's
 * is the changes to its clones since it cloned them, then its parent's from
 * before it was forked. A merge has none of its own.
 */
export function createOverlayHistory(options: {
  repo: Repo;
  rootUrl: AutomergeUrl;
  // A repo reading `overlay` as it is now, for its members.
  readerFor: (overlay: Overlay) => OverlayRepo;
}): OverlayHistory {
  const { repo, readerFor } = options;

  return { entries, watch, point };

  async function entries(overlay: Overlay, seen = new Set<Overlay>()): Promise<HistoryEntry[]> {
    if (seen.has(overlay)) return [];
    seen.add(overlay);
    if (overlay === null) return groupRows(await mainRows(), null);
    const handle = await repo.find<unknown>(overlay);
    const doc = handle.doc();
    if (!isDraftDoc(doc)) return [];
    const own = groupRows(await draftRows(doc), overlay);
    const forkedAt = createdAt(handle.doc() as Automerge.Doc<unknown>) ?? 0;
    const inherited = (await entries(doc.parent, seen)).filter((entry) => entry.time <= forkedAt);
    return [...own, ...inherited];
  }

  async function point(overlay: Overlay, at: string): Promise<Point | undefined> {
    const docs = await sourcesOf(overlay);
    for (const doc of docs) {
      const time = timeOfChange(doc, at);
      if (time !== undefined) return { hash: at, time };
    }
    return undefined;
  }

  function watch(overlay: Overlay, listener: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => live && listener(), HISTORY_DEBOUNCE_MS);
    };
    const stops: (() => void)[] = [];
    // Every overlay up to main: a draft inherits its parent's history.
    void (async () => {
      const seen = new Set<Overlay>();
      let cursor: Overlay = overlay;
      while (live && !seen.has(cursor)) {
        seen.add(cursor);
        stops.push(readerFor(cursor).onMembers(soon));
        if (cursor === null) break;
        const handle = await repo.find<unknown>(cursor);
        if (!live) return;
        handle.on("change", soon);
        stops.push(() => handle.off("change", soon));
        const doc = handle.doc();
        cursor = isDraftDoc(doc) ? doc.parent : null;
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
      for (const stop of stops) stop();
    };
  }

  // Every change to main's members. A document added later brings its
  // history from before that: the root's own first change can't tell where
  // to cut, since documents are made "now" whatever their changes say (an
  // import replaying old commits, say).
  async function mainRows(): Promise<Row[]> {
    const rows: Row[] = [];
    for (const member of await readerFor(null).members()) {
      const doc = await docOf(member.url);
      if (doc) rows.push(...rowsOf(doc, member.url, encodeHeads([])));
    }
    return rows;
  }

  // The changes to a draft's clones since they were cloned.
  async function draftRows(draft: DraftDoc): Promise<Row[]> {
    const rows: Row[] = [];
    for (const [member, entry] of Object.entries(draft.clones ?? {})) {
      if (!entry.cloneUrl) continue;
      const doc = await docOf(entry.cloneUrl);
      // A document made in the draft is its own clone: all of it is new.
      const since = entry.cloneUrl === member ? encodeHeads([]) : entry.clonedAt;
      if (doc) rows.push(...rowsOf(doc, member as AutomergeUrl, since));
    }
    return rows;
  }

  // The documents `overlay`'s history is read from, its parents' included.
  async function sourcesOf(overlay: Overlay): Promise<Automerge.Doc<unknown>[]> {
    const out: Automerge.Doc<unknown>[] = [];
    const seen = new Set<Overlay>();
    let cursor: Overlay = overlay;
    while (!seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === null) {
        for (const member of await readerFor(null).members()) {
          const doc = await docOf(member.url);
          if (doc) out.push(doc);
        }
        break;
      }
      const doc = (await repo.find<unknown>(cursor)).doc();
      if (!isDraftDoc(doc)) break;
      for (const entry of Object.values(doc.clones ?? {})) {
        const clone = entry.cloneUrl && (await docOf(entry.cloneUrl));
        if (clone) out.push(clone);
      }
      cursor = doc.parent;
    }
    return out;
  }

  async function docOf(url: AutomergeUrl): Promise<Automerge.Doc<unknown> | undefined> {
    try {
      const handle: DocHandle<unknown> = await repo.find<unknown>(url);
      return handle.doc() as Automerge.Doc<unknown> | undefined;
    } catch (err) {
      console.warn(`[drafts] couldn't read ${url} for its history:`, err);
      return undefined;
    }
  }
}
