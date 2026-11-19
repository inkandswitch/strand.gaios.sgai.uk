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
//
// `preview` marks what a merge would leave its target as: the target forked,
// with the merging draft's changes merged into the fork alone. It never lists,
// and is discarded once the merge is confirmed or cancelled.
export type DraftDoc = {
  "@patchwork": { type: "draft" };
  isMain?: boolean;
  preview?: boolean;
  name?: string;
  parent: AutomergeUrl;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
  mergedAt?: number;
  // Main draft only: monotonic counter behind new forks' default names
  // ("Draft N"). Never decremented, so numbers aren't reused after deletes.
  draftCounter?: number;
  // The git branch this draft syncs with: main's is `remote.branch`, any
  // other draft's is the branch of its name. Absent until it's linked.
  git?: DraftGit;
  // Main draft only: the repo the workspace syncs with.
  remote?: GitRemoteConfig;
};

// A git commit and the version of the draft both sides agree it is: the heads
// of every folder and file doc in the draft, keyed by original url, when the
// commit was made or imported. Written once, never edited.
export type SyncPoint = {
  sha: string;
  // the commit's tree, so it needn't be looked up
  tree: string;
  heads: Record<AutomergeUrl, UrlHeads>;
  at: number;
};

export type DraftGit = {
  // Keyed `${sha}/${random id}`, so two clients recording the same commit
  // both survive the merge: that's how a commit imported twice shows up.
  syncPoints: Record<string, SyncPoint>;
  // Main only: the commits of linked drafts merged into main in Patchwork
  // since main's last export, which becomes their merge commit.
  mergedBranches?: Record<string, true>;
};

export type GitRemoteConfig = {
  owner: string;
  repo: string;
  branch: string;
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

// Everything about a workspace's drafts, answered for `drafts` and pushed on
// every change. Main is a draft like the others: `main` is its url (the main
// draft's, or the workspace's until the first fork makes one), and that's
// what `checkedOut` is while main is checked out.
export type DraftsState = {
  workspace: AutomergeUrl;
  main: AutomergeUrl;
  checkedOut: AutomergeUrl;
  status: DraftStatus;
  // Main first, then every draft that hasn't been merged, each beneath the
  // one it was forked off.
  drafts: DraftEntry[];
};

export type DraftEntry = {
  url: AutomergeUrl;
  // The user's name for it, or the default label ("Main", "Draft").
  name: string;
  // The draft it was forked off; null for main.
  parent: AutomergeUrl | null;
  // 0 for main, 1 for a draft forked off main, and so on.
  depth: number;
};

// `verifying` while the starting draft (the provider's `draft` attribute)
// hasn't been confirmed as a live draft of the workspace yet (documents wait),
// `unavailable` once that has taken too long, `ready` once a checkout holds.
export type DraftStatus = "verifying" | "ready" | "unavailable";

// What the provider has checked out, in memory only: null for main, the root
// itself.
export type DraftSelection = {
  checkedOut: AutomergeUrl | null;
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
