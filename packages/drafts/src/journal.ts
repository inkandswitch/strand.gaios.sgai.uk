import { Automerge } from "@automerge/automerge-repo/slim";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";

import { HISTORY_GAP_SECONDS, metasOf } from "./history.js";
import type {
  DraftDoc,
  HistoryEntry,
  HistoryGroup,
  HistoryGroupsDoc,
  HistoryRefs,
  JournalDoc,
  JournalMessage,
  Overlay,
  Workspace,
} from "./overlay-types.js";
import { isDraftDoc } from "./overlay-types.js";

// Journals and their history groups (see `JournalDoc`). Everything here takes
// the base repo.

/** Where `line`'s journal is, if it has one yet. */
export async function historyRefsOf(
  repo: Repo,
  workspace: DocHandle<Workspace> | null,
  line: Overlay
): Promise<HistoryRefs | undefined> {
  if (line === null) return workspace?.doc()?.history;
  const doc = (await repo.find<DraftDoc>(line)).doc();
  return isDraftDoc(doc) ? doc.history : undefined;
}

/**
 * `line`'s journal, made now if it has none: main's fresh, a draft's as a
 * fork of its parent's (made first if need be), so every journal of a root
 * shares main's history.
 */
export async function ensureHistory(
  repo: Repo,
  workspace: DocHandle<Workspace>,
  line: Overlay
): Promise<HistoryRefs> {
  const existing = await historyRefsOf(repo, workspace, line);
  if (existing) return existing;
  if (line === null) {
    const refs = createHistory(repo);
    workspace.change((d) => {
      d.history ??= refs;
    });
    // Someone else's may have won.
    return workspace.doc()!.history!;
  }
  const draft = await repo.find<DraftDoc>(line);
  const parent = draft.doc()?.parent ?? null;
  const refs = await forkHistory(repo, await ensureHistory(repo, workspace, parent));
  draft.change((d) => {
    d.history ??= refs;
  });
  return draft.doc()!.history!;
}

/** A new, empty journal and groups document. */
export function createHistory(repo: Repo): HistoryRefs {
  const journal = repo.create<JournalDoc>({
    "@patchwork": { type: "journal" },
    members: {},
    authors: {},
  });
  const groups = repo.create<HistoryGroupsDoc>({
    "@patchwork": { type: "history-groups" },
    groups: {},
  });
  return { journal: journal.url, groups: groups.url };
}

/** Copies of `refs`' journal and groups as they are now, for a new draft. */
export async function forkHistory(repo: Repo, refs: HistoryRefs): Promise<HistoryRefs> {
  const [journal, groups] = await Promise.all([
    repo.find<JournalDoc>(refs.journal),
    repo.find<HistoryGroupsDoc>(refs.groups),
  ]);
  return { journal: repo.clone(journal).url, groups: repo.clone(groups).url };
}

/** `from`'s records and groups, merged into `into`'s. */
export async function mergeHistory(repo: Repo, into: HistoryRefs, from: HistoryRefs): Promise<void> {
  for (const key of ["journal", "groups"] as const) {
    if (into[key] === from[key]) continue;
    const [target, source] = await Promise.all([
      repo.find<unknown>(into[key]),
      repo.find<unknown>(from[key]),
    ]);
    const incoming = source.doc() as Automerge.Doc<unknown>;
    target.update((doc) => Automerge.merge(doc as Automerge.Doc<unknown>, incoming));
  }
}

export type JournalRecord = {
  // Each member it records, and its heads now (Automerge's hex hashes).
  members: Record<AutomergeUrl, string[]>;
  // When the edit was made, in Unix seconds.
  time: number;
  message: JournalMessage;
  author?: AutomergeUrl;
};

/**
 * Writes one record into `journal`, and folds it into this actor's latest
 * group in `groups`, or starts one. Answers the record's hash.
 */
export function writeRecord(
  journal: DocHandle<JournalDoc>,
  groups: DocHandle<HistoryGroupsDoc>,
  record: JournalRecord
): string {
  const actor = Automerge.getActorId(journal.doc() as Automerge.Doc<unknown>);
  journal.change(
    (d) => {
      for (const [member, heads] of Object.entries(record.members) as [AutomergeUrl, string[]][]) {
        // Read back after assigning: `??=` answers the plain object given,
        // not the document's, and writes to that would be lost.
        if (!d.members[member]) d.members[member] = { heads: {} };
        const entry = d.members[member];
        for (const hash of Object.keys(entry.heads)) {
          if (!heads.includes(hash)) delete entry.heads[hash];
        }
        for (const hash of heads) if (!entry.heads[hash]) entry.heads[hash] = true;
      }
      if (record.author && d.authors[actor] !== record.author) d.authors[actor] = record.author;
    },
    { time: record.time, message: JSON.stringify(record.message) }
  );
  const last = Automerge.getLastLocalChange(journal.doc() as Automerge.Doc<unknown>);
  const hash = last ? Automerge.decodeChange(last).hash : "";
  const members = Object.keys(record.members) as AutomergeUrl[];
  groups.change(
    (d) => {
      const latest = latestGroupOf(d.groups, actor);
      if (
        latest &&
        latest.draft === record.message.draft &&
        record.time - latest.end <= HISTORY_GAP_SECONDS
      ) {
        latest.end = Math.max(latest.end, record.time);
        latest.last = hash;
        latest.changes += 1;
        for (const member of members) if (!latest.members[member]) latest.members[member] = true;
        if (record.author && !latest.author) latest.author = record.author;
        return;
      }
      const group: HistoryGroup = {
        actor,
        draft: record.message.draft,
        start: record.time,
        end: record.time,
        first: hash,
        last: hash,
        members: Object.fromEntries(members.map((member) => [member, true as const])),
        changes: 1,
      };
      if (record.author) group.author = record.author;
      d.groups[`${actor}:${hash}`] = group;
    },
    { time: record.time }
  );
  return hash;
}

function latestGroupOf(
  groups: Record<string, HistoryGroup>,
  actor: string
): HistoryGroup | undefined {
  let latest: HistoryGroup | undefined;
  for (const group of Object.values(groups)) {
    if (group.actor !== actor) continue;
    if (!latest || group.end > latest.end) latest = group;
  }
  return latest;
}

/**
 * Groups as history entries, the newest first: groups from different actors
 * no more than the gap apart read as one entry, named by its newest record.
 */
export function entriesOf(groups: HistoryGroup[]): HistoryEntry[] {
  const sorted = [...groups].sort((a, b) => a.start - b.start || (a.actor < b.actor ? -1 : 1));
  const rows: { groups: HistoryGroup[]; start: number; end: number }[] = [];
  for (const group of sorted) {
    const row = rows[rows.length - 1];
    if (row && group.start - row.end <= HISTORY_GAP_SECONDS) {
      row.groups.push(group);
      row.end = Math.max(row.end, group.end);
    } else {
      rows.push({ groups: [group], start: group.start, end: group.end });
    }
  }
  return rows.reverse().map((row) => {
    const byEnd = [...row.groups].sort((a, b) => b.end - a.end);
    const newest = byEnd[0];
    const actors: string[] = [];
    const members = new Set<AutomergeUrl>();
    for (const group of byEnd) {
      const who = group.author ?? group.actor;
      if (!actors.includes(who)) actors.push(who);
      for (const member of Object.keys(group.members) as AutomergeUrl[]) members.add(member);
    }
    return {
      id: newest.last,
      overlay: newest.draft,
      start: row.start,
      time: row.end,
      actors,
      members: [...members],
    };
  });
}

/** Each member's heads as the journal had them at `record`, if it has it. */
export function headsAtRecord(
  journal: Automerge.Doc<JournalDoc>,
  record: string
): { time: number; members: Record<AutomergeUrl, string[]> } | undefined {
  const meta = metasOf(journal as Automerge.Doc<unknown>).find((change) => change.hash === record);
  if (!meta) return undefined;
  const view = Automerge.view(journal, [record] as Automerge.Heads);
  const members: Record<AutomergeUrl, string[]> = {};
  for (const [member, entry] of Object.entries(view.members ?? {}) as [
    AutomergeUrl,
    { heads: Record<string, true> },
  ][]) {
    members[member] = Object.keys(entry.heads ?? {});
  }
  return { time: meta.time, members };
}
