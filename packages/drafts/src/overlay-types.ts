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

// On the root: the one pointer to its overlays, written when the first one is
// made.
export type HasOverlays = {
  "@patchwork"?: {
    type?: string;
    overlaysUrl?: AutomergeUrl;
  };
};

// Every overlay of a root.
export type OverlayIndex = {
  "@patchwork": { type: "overlay-index" };
  drafts: AutomergeUrl[];
  merges: AutomergeUrl[];
};

export type DraftDoc = {
  "@patchwork": { type: "draft" };
  // Absent: "Draft".
  name?: string;
  // The draft it was forked off; null is main.
  parent: AutomergeUrl | null;
  clones: Clones;
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

export type OverlaysState = {
  checkedOut: Overlay;
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
