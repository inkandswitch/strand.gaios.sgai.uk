import { Automerge } from "@automerge/automerge-repo/slim";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import { canonicalUrl, walkDocTree } from "./children.js";
import { cloneAt } from "./draft-clones.js";
import type {
  CloneEntry,
  DraftDoc,
  HasOverlays,
  MergeDoc,
  OverlayIndex,
} from "./overlay-types.js";

// What the overlay provider's commands change. Each takes the base repo: the
// overlays' own bookkeeping never resolves through an overlay.

// The root's index, made the first time it's needed.
export async function ensureIndex(
  repo: Repo,
  root: DocHandle<HasOverlays>
): Promise<DocHandle<OverlayIndex>> {
  const existing = await findIndex(repo, root);
  if (existing) return existing;
  const index = repo.create<OverlayIndex>({
    "@patchwork": { type: "overlay-index" },
    drafts: [],
    merges: [],
  });
  root.change((d) => {
    // Mutate `@patchwork` in place. Reassigning a spread would carry
    // references to existing Automerge objects into a new object.
    if (!d["@patchwork"]) d["@patchwork"] = {};
    d["@patchwork"]!.overlaysUrl = index.url;
  });
  return index;
}

export async function findIndex(
  repo: Repo,
  root: DocHandle<HasOverlays>
): Promise<DocHandle<OverlayIndex> | null> {
  const url = root.doc()?.["@patchwork"]?.overlaysUrl;
  return url && isValidAutomergeUrl(url) ? repo.find<OverlayIndex>(url) : null;
}

// A draft forked off `parent` (null for main) as it is now. Forking clones
// nothing: the draft records, per member, the version it branches off, and
// reads that until the member's first write clones it.
export async function createDraft(
  repo: Repo,
  root: DocHandle<HasOverlays>,
  parent: AutomergeUrl | null
): Promise<AutomergeUrl> {
  const index = await ensureIndex(repo, root);
  const parentDoc = parent ? (await repo.find<DraftDoc>(parent)).doc() : null;
  const clones = await forkPoints(repo, root.url, parentDoc);
  const draft = repo.create<DraftDoc>({
    "@patchwork": { type: "draft" },
    parent,
    clones,
  });
  index.change((d) => {
    d.drafts.push(draft.url);
  });
  return draft.url;
}

export async function renameDraft(
  repo: Repo,
  draft: AutomergeUrl,
  name: string
): Promise<void> {
  const handle = await repo.find<DraftDoc>(draft);
  const trimmed = name.trim();
  handle.change((d) => {
    if (trimmed) d.name = trimmed;
    else delete d.name;
  });
}

// `source` merged into `target`, as a merge to look over first. There's one
// per source and target: asking again answers the one there is.
export async function createMerge(
  repo: Repo,
  root: DocHandle<HasOverlays>,
  source: AutomergeUrl | null,
  target: AutomergeUrl | null
): Promise<AutomergeUrl> {
  const index = await ensureIndex(repo, root);
  for (const url of index.doc()?.merges ?? []) {
    const doc = (await repo.find<MergeDoc>(url)).doc();
    if (doc?.source === source && doc?.target === target) return url;
  }
  const merge = repo.create<MergeDoc>({
    "@patchwork": { type: "merge" },
    source,
    target,
    clones: {},
  });
  index.change((d) => {
    d.merges.push(merge.url);
  });
  return merge.url;
}

// Takes a draft or a merge off the list. A draft goes with every merge it's
// the source or target of. Nothing is merged, and its members stay where
// they are.
export async function deleteOverlay(
  repo: Repo,
  index: DocHandle<OverlayIndex>,
  url: AutomergeUrl
): Promise<void> {
  const inputs = await mergesOf(repo, index, url);
  index.change((d) => {
    remove(d.drafts, url);
    remove(d.merges, url);
    for (const merge of inputs) remove(d.merges, merge);
  });
}

// What a merge reads, for accepting it.
export type MergeReading = {
  // Every member of the merge, once they're all known.
  members(): Promise<AutomergeUrl[]>;
  // A member as the merge has it.
  doc(url: AutomergeUrl): Promise<Automerge.Doc<unknown>>;
};

// The target takes the merge's content, and the merge, and a source that's a
// draft, come off the list.
export async function acceptMerge(
  repo: Repo,
  index: DocHandle<OverlayIndex>,
  merge: DocHandle<MergeDoc>,
  reading: MergeReading
): Promise<void> {
  const doc = merge.doc();
  if (!doc) throw new Error(`[drafts] merge ${merge.url} has no document`);
  const target = doc.target ? await repo.find<DraftDoc>(doc.target) : null;
  for (const url of await reading.members()) {
    const merged = await reading.doc(url);
    const copy = await writableCopy(repo, target, url);
    if (Automerge.hasHeads(copy.doc() as Automerge.Doc<unknown>, Automerge.getHeads(merged)))
      continue;
    copy.update((current) => Automerge.merge(current as Automerge.Doc<unknown>, merged));
  }
  const gone = doc.source ? [...(await mergesOf(repo, index, doc.source))] : [];
  index.change((d) => {
    remove(d.merges, merge.url);
    if (!doc.source) return;
    remove(d.drafts, doc.source);
    for (const other of gone) remove(d.merges, other);
  });
}

// The forks of a draft off `parent` (null for main), per member. A member the
// parent cloned branches off its clone as it is now; one the parent only
// recorded a fork point for keeps that point, since the parent never changed
// it; every other member of main's branches off the member as it is now.
export async function forkPoints(
  repo: Repo,
  rootUrl: AutomergeUrl,
  parent: DraftDoc | null
): Promise<Record<AutomergeUrl, CloneEntry>> {
  const parentClones = parent?.clones ?? {};
  const { members } = await walkDocTree(canonicalUrl(rootUrl), (url) => repo.find(url));
  const clones: Record<AutomergeUrl, CloneEntry> = {};
  const sources: { url: AutomergeUrl; read: AutomergeUrl }[] = members
    .filter((member) => !parentClones[member.url])
    .map((member) => ({ url: member.url, read: member.url }));
  for (const [url, entry] of Object.entries(parentClones) as [AutomergeUrl, CloneEntry][]) {
    if (entry.cloneUrl) sources.push({ url, read: entry.cloneUrl });
    else clones[url] = forkEntry(url, entry.source, entry.clonedAt);
  }
  await Promise.all(
    sources.map(async ({ url, read }) => {
      try {
        const handle = await repo.find<unknown>(read);
        clones[url] = forkEntry(url, read, handle.heads());
      } catch (err) {
        console.warn("[drafts] failed to fork member:", url, err);
      }
    })
  );
  return clones;
}

// Automerge rejects `undefined` values, so `source` is only set when the
// draft forks off something other than the member itself.
function forkEntry(
  url: AutomergeUrl,
  source: AutomergeUrl | undefined,
  clonedAt: CloneEntry["clonedAt"]
): CloneEntry {
  const from = source ? canonicalUrl(source) : null;
  const heads = [...clonedAt] as UrlHeads;
  return from && from !== url ? { source: from, clonedAt: heads } : { clonedAt: heads };
}

// Where a merge into `draft` (null for main) writes `url`: main's member
// itself, the draft's clone, or a clone made now of the version the draft
// reads, so nothing outside the draft is written.
async function writableCopy(
  repo: Repo,
  draft: DocHandle<DraftDoc> | null,
  url: AutomergeUrl
): Promise<DocHandle<unknown>> {
  if (!draft) return repo.find<unknown>(url);
  const entry = draft.doc()?.clones?.[url];
  if (entry?.cloneUrl) return repo.find<unknown>(entry.cloneUrl);
  const source = await repo.find<unknown>(entry?.source ?? url);
  const clonedAt = entry ? ([...entry.clonedAt] as UrlHeads) : source.heads();
  const clone = cloneAt(repo, source, clonedAt);
  const cloneUrl = canonicalUrl(clone.url);
  draft.change((d) => {
    const recorded = d.clones[url];
    if (recorded) recorded.cloneUrl = cloneUrl;
    else d.clones[url] = { clonedAt, cloneUrl };
  });
  return clone;
}

// The merges `draft` is the source or target of.
async function mergesOf(
  repo: Repo,
  index: DocHandle<OverlayIndex>,
  draft: AutomergeUrl
): Promise<Set<AutomergeUrl>> {
  const found = new Set<AutomergeUrl>();
  for (const url of index.doc()?.merges ?? []) {
    if (url === draft) continue;
    const doc = (await repo.find<MergeDoc>(url)).doc();
    if (doc?.source === draft || doc?.target === draft) found.add(url);
  }
  return found;
}

function remove(list: AutomergeUrl[], url: AutomergeUrl): void {
  const i = list.indexOf(url);
  if (i >= 0) list.splice(i, 1);
}
