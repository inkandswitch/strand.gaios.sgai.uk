import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo/slim";

// An overlay's version of one member. A draft records, when it's forked, the
// version of each member it branches off (`source` at `clonedAt`; `source`
// absent for the member itself) and reads that until its first write clones
// it into `cloneUrl`. A merge records only `cloneUrl`, for a member first
// written while it's looked over, with `clonedAt` the heads it was cloned at.
// A member made while an overlay is checked out is its own clone (`cloneUrl`
// the member itself, `clonedAt` empty).
export type CloneEntry = {
  source?: AutomergeUrl;
  clonedAt: UrlHeads;
  cloneUrl?: AutomergeUrl;
};

type Clones = Record<AutomergeUrl, CloneEntry>;

// On the root: the one pointer to its workspace, written when the first
// overlay is made.
export type HasWorkspace = {
  "@patchwork"?: {
    type?: string;
    workspaceUrl?: AutomergeUrl;
  };
};

// A root's drafts and pull requests. A merge that isn't listed is a preview.
// `history` is main's journal and history groups, made with main's first
// recorded edit (or its first draft).
export type Workspace = {
  "@patchwork": { type: "workspace" };
  drafts: AutomergeUrl[];
  merges: AutomergeUrl[];
  history?: HistoryRefs;
};

export type DraftDoc = {
  "@patchwork": { type: "draft" };
  // Absent: "Draft".
  name?: string;
  // The draft it was forked off; null is main.
  parent: AutomergeUrl | null;
  clones: Clones;
  // Its journal and history groups: forks of its parent's, made with it.
  history?: HistoryRefs;
};

// `source` merged into `target`, either of them main (null).
export type MergeDoc = {
  "@patchwork": { type: "merge" };
  source: AutomergeUrl | null;
  target: AutomergeUrl | null;
  clones: Clones;
};

// A draft or a merge by its url, or null for main.
export type Overlay = AutomergeUrl | null;

// `loading` while the overlay the provider was started on is being opened
// (documents beneath wait), `unavailable` once that has taken too long,
// `ready` once a checkout holds.
export type OverlayStatus = "loading" | "ready" | "unavailable";

// A point in an overlay's history, named by the newest change of a history
// entry (`HistoryEntry.id`); null for the working copy.
export type At = string | null;

export type OverlaysState = {
  checkedOut: Overlay;
  // The point in its history it's checked out at; null for the working copy.
  at: At;
  status: OverlayStatus;
  drafts: DraftEntry[];
  merges: MergeEntry[];
};

export type DraftEntry = {
  url: AutomergeUrl;
  // The stored name, or "Draft".
  name: string;
  // The nearest draft it was forked off that's still listed; null is main.
  parent: AutomergeUrl | null;
};

export type MergeEntry = {
  url: AutomergeUrl;
  source: AutomergeUrl | null;
  target: AutomergeUrl | null;
  // A pull request, listed in the workspace; false for a preview.
  published: boolean;
};

// One member, as an overlay has it.
export type Member = {
  // The same in every overlay.
  url: AutomergeUrl;
  // The version this overlay reads.
  heads: UrlHeads;
  // The member it was reached from; null for the root.
  parent: AutomergeUrl | null;
};

// --- History -----------------------------------------------------------------

// A burst of changes across an overlay's members: consecutive changes no
// more than ten minutes apart. A draft's history is its own changes since it
// was forked, then its parent's from before that.
export type HistoryEntry = {
  // The newest change in it, by hash: what `at` names to view it.
  id: string;
  // Whose changes they are.
  overlay: Overlay;
  // When the first and the last of its changes were made, in Unix seconds.
  start: number;
  time: number;
  // Who made them, by Automerge actor, the latest first.
  actors: string[];
  // The members they changed.
  members: AutomergeUrl[];
};

// --- Journals ----------------------------------------------------------------

// Main's, and each draft's, record of its own edits.
export type HistoryRefs = { journal: AutomergeUrl; groups: AutomergeUrl };

// One record per edit made here: every change to the journal is a version of
// the whole root, each member at the heads it records (members it doesn't
// list read as they did before any record). Heads are sets, so records made
// at the same time merge into both. A draft's journal is a fork of its
// parent's, and merging a draft merges its journal in too. Each record's
// change message is `JournalMessage` as JSON.
export type JournalDoc = {
  "@patchwork": { type: "journal" };
  members: Record<AutomergeUrl, { heads: Record<string, true> }>;
  // Who's behind each actor that wrote a record: a contact.
  authors: Record<string, AutomergeUrl>;
};

export type JournalMessage = {
  // The draft the edit was made in; null for main.
  draft: AutomergeUrl | null;
  // The merge, for the record a merge left when it was accepted.
  merge?: AutomergeUrl;
};

// A journal's records in bursts, kept as they're made. Each actor only ever
// writes its own groups, so groups are never written at the same time.
export type HistoryGroupsDoc = {
  "@patchwork": { type: "history-groups" };
  // Keyed `${actor}:${first record's hash}`.
  groups: Record<string, HistoryGroup>;
};

export type HistoryGroup = {
  // The journal's actor that wrote it, and who that is, if known.
  actor: string;
  author?: AutomergeUrl;
  // Where its edits were made; null for main.
  draft: AutomergeUrl | null;
  // When its first and last records were made, in Unix seconds.
  start: number;
  end: number;
  // Its first and latest records, by hash: `last` is the point it reaches.
  first: string;
  last: string;
  members: Record<AutomergeUrl, true>;
  changes: number;
};

// --- Conflicts ---------------------------------------------------------------

// Where a conflict is, in auto and in merged alike: a path into the document,
// and inside a text, the stretch strictly between two characters, named by
// Automerge cursors ("start" and "end" for the text's ends).
export type Place = {
  path: (string | number)[];
  from?: string;
  to?: string;
};

// A place where a plugin says the source's and the target's changes don't
// go together, what each side has there, and, where keeping both makes
// sense, what that reads as.
export type Conflict = {
  at: Place;
  source: unknown;
  target: unknown;
  both?: unknown;
};

export type ConflictState = "open" | "source" | "target" | "both" | "edited";

// Every conflict of a merge, by member.
export type MergeConflicts = Record<AutomergeUrl, (Conflict & { state: ConflictState })[]>;

// The answer to `repo:handle-descriptor`: read `cloneUrl` when there is one.
export type HandleDescriptor = { url: AutomergeUrl; cloneUrl?: AutomergeUrl };

export const DRAFT_NAME = "Draft";

export function isDraftDoc(value: unknown): value is DraftDoc {
  return markerOf(value) === "draft";
}

export function isMergeDoc(value: unknown): value is MergeDoc {
  return markerOf(value) === "merge";
}

function markerOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const marker = (value as { "@patchwork"?: { type?: unknown } })["@patchwork"];
  return typeof marker?.type === "string" ? marker.type : undefined;
}
