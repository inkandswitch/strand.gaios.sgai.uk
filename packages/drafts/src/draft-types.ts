import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo/slim";

// A draft's version of one doc. Forking records where the draft branches
// off — `source` (the parent draft's clone; absent for the original) at
// `clonedAt` — and the draft reads that snapshot until its first write
// clones it there into `cloneUrl`. A doc created on the draft is its own
// clone (`cloneUrl` the doc itself, `clonedAt` empty). `mergedAt` is the
// target's heads after the clone merged back.
export type CloneEntry = {
  source?: AutomergeUrl;
  clonedAt: UrlHeads;
  cloneUrl?: AutomergeUrl;
  mergedAt?: UrlHeads;
};

// `parent` points at the URL this draft branches off of: the main draft (for
// top-level drafts, listed in `mainDraft.drafts`) or another `DraftDoc` (for
// sub-drafts attached via `DraftDoc.drafts`).
//
// `isMain` marks the single "main draft" a root points at via
// `@patchwork.mainDraftUrl`. The main draft is bookkeeping only: it is never
// resolved through, and its `drafts` holds the top-level draft list. Its
// `clones` are unused.
//
// `mergedAt` is a wall-clock timestamp set when the draft is merged into
// its parent; absent means "still open". Merged drafts drop out of the list.
//
// `name` is the user-given display name; absent means the default label
// ("Draft", or "Main" for the main draft).
export type DraftDoc = {
  "@patchwork": { type: "draft" };
  isMain?: boolean;
  name?: string;
  parent: AutomergeUrl;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
  mergedAt?: number;
  // Main draft only: monotonic counter behind new forks' default names
  // ("Draft N"). Never decremented, so numbers aren't reused after deletes.
  draftCounter?: number;
};

// One member doc's pinned view within a checkpoint. `to` is the heads to render
// the doc at (a fixed-heads, read-only view); omit it to leave the doc live.
// `from` is a diff baseline, unused here but kept so a checkpoint means the
// same thing it does elsewhere.
export type DocCheckpoint = {
  from?: UrlHeads;
  to?: UrlHeads;
};

// A frozen, read-only view of a draft (or main): maps each member doc's
// original url to the heads to view it at.
export type DraftCheckpoint = Record<AutomergeUrl, DocCheckpoint>;

// What the draft provider has checked out, answered for `draft:selection` and
// set with `draft:select`. In memory only. `checkedOut = null` means main,
// the root itself.
export type DraftSelection = {
  checkedOut: AutomergeUrl | null;
  at: DraftCheckpoint | null;
};

// Answered for `draft:status`. `verifying` while the starting draft (the
// provider's `draft` attribute) hasn't been confirmed as a live draft of the
// root yet (documents wait), `unavailable` once that has taken too long,
// `ready` once a selection holds.
export type DraftStatus = "verifying" | "ready" | "unavailable";

// One entry in the `draft:list` push.
export type DraftSummary = {
  // The `DraftDoc` url for a real draft; the main draft's url (or the root's,
  // before there is one) for `main`.
  url: AutomergeUrl;
  // What this draft was forked off: the main draft's url for a top-level
  // draft, another draft's url for a sub-fork. `null` on main itself.
  parent: AutomergeUrl | null;
  // Number of sub-drafts (`DraftDoc.drafts.length`).
  childCount: number;
  // User-given display name; `null` (not optional, to stay
  // structured-cloneable) means unnamed.
  name: string | null;
};

// Response shape for `draft:list`: the root's `main` entry plus the flat,
// depth-first list of its (non-merged) drafts.
export type DraftList = {
  main: DraftSummary;
  drafts: DraftSummary[];
};

// A document that has been drafted carries `@patchwork.mainDraftUrl`
// pointing at its single main draft, whose `drafts` lists the top-level
// drafts. The pointer is created by the first fork, so it is absent until
// then.
export type HasDrafts = {
  "@patchwork"?: {
    type?: string;
    mainDraftUrl?: AutomergeUrl;
  };
};

export function isDraftDoc(value: unknown): value is DraftDoc {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const marker = v["@patchwork"] as { type?: string } | undefined;
  return marker?.type === "draft" && !!v.clones && typeof v.clones === "object";
}
