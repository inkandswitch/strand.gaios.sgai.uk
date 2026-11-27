import { Automerge } from "@automerge/automerge-repo/slim";
import {
  encodeHeads,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";

import { createdAt, groupRows, rowsOf, timeOfChange, type Point, type Row } from "../history.js";
import { entriesOf, headsAtRecord, historyRefsOf } from "../journal.js";
import type { OverlayRepo } from "../overlay-repo.js";
import type {
  DraftDoc,
  HistoryEntry,
  HistoryGroupsDoc,
  JournalDoc,
  Overlay,
  Workspace,
} from "../overlay-types.js";
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
 * Each overlay's history (see `HistoryEntry`). Where it has a journal, its
 * recorded history groups, named by their records; from before its journal
 * began, worked out from its members' changes: main's every change to its
 * members, a draft's the changes to its clones since it cloned them, then its
 * parent's from before it was forked. A merge has none of its own.
 */
export function createOverlayHistory(options: {
  repo: Repo;
  rootUrl: AutomergeUrl;
  // A repo reading `overlay` as it is now, for its members.
  readerFor: (overlay: Overlay) => OverlayRepo;
  // The root's workspace, if it has one, where main's journal is.
  workspace: () => Promise<DocHandle<Workspace> | null>;
}): OverlayHistory {
  const { repo, readerFor } = options;

  return { entries, watch, point };

  async function entries(overlay: Overlay): Promise<HistoryEntry[]> {
    const before = await reconstructed(overlay);
    const refs = await historyRefsOf(repo, await options.workspace(), overlay);
    if (!refs) return before;
    const groups = Object.values((await repo.find<HistoryGroupsDoc>(refs.groups)).doc()?.groups ?? {});
    if (!groups.length) return before;
    const began = Math.min(...groups.map((group) => group.start));
    return [...entriesOf(groups), ...before.filter((entry) => entry.time < began)];
  }

  // History worked out from the members' changes, for before a journal.
  async function reconstructed(overlay: Overlay, seen = new Set<Overlay>()): Promise<HistoryEntry[]> {
    if (seen.has(overlay)) return [];
    seen.add(overlay);
    if (overlay === null) return groupRows(await mainRows(), null);
    const handle = await repo.find<unknown>(overlay);
    const doc = handle.doc();
    if (!isDraftDoc(doc)) return [];
    const own = groupRows(await draftRows(doc), overlay);
    const forkedAt = createdAt(handle.doc() as Automerge.Doc<unknown>) ?? 0;
    const inherited = (await reconstructed(doc.parent, seen)).filter((entry) => entry.time <= forkedAt);
    return [...own, ...inherited];
  }

  async function point(overlay: Overlay, at: string): Promise<Point | undefined> {
    // A record of the journal: every member exactly as it recorded them.
    const refs = await historyRefsOf(repo, await options.workspace(), overlay);
    if (refs) {
      const journal = (await repo.find<JournalDoc>(refs.journal)).doc();
      const recorded = journal && headsAtRecord(journal, at);
      if (recorded) return { hash: at, time: recorded.time, members: recorded.members };
    }
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
    const listen = (handle: DocHandle<unknown>, onChange: () => void) => {
      handle.on("change", onChange);
      stops.push(() => handle.off("change", onChange));
    };
    // Its history groups, once it has them, as they're recorded.
    const groupsWatched = new Set<AutomergeUrl>();
    const followGroups = async (line: Overlay) => {
      const refs = await historyRefsOf(repo, await options.workspace(), line);
      if (!live || !refs || groupsWatched.has(refs.groups)) return;
      groupsWatched.add(refs.groups);
      listen(await repo.find<unknown>(refs.groups), soon);
    };
    // Every overlay up to main: a draft inherits its parent's history.
    void (async () => {
      const seen = new Set<Overlay>();
      let cursor: Overlay = overlay;
      while (live && !seen.has(cursor)) {
        seen.add(cursor);
        stops.push(readerFor(cursor).onMembers(soon));
        const line = cursor;
        const holder = cursor === null ? await options.workspace() : await repo.find<unknown>(cursor);
        if (!live) return;
        // Where its journal is noted: when one's made, follow it.
        if (holder) {
          listen(holder as DocHandle<unknown>, () => {
            soon();
            void followGroups(line);
          });
        }
        void followGroups(line);
        if (cursor === null) break;
        const doc = (holder as DocHandle<unknown>).doc();
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
