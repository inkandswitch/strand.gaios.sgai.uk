import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim";

import type { DraftDoc, HasDrafts } from "./draft-types.js";
import { ensureMainDraft } from "./draft-docs.js";
import { forkPoints, mergeDraft } from "./draft-forks.js";

// What the draft list's commands change. Each takes the base repo: the
// drafts' own bookkeeping never resolves through a `DraftRepo`.

// Fork `parentUrl` (null = main) as a new child draft, and return it. Forking
// clones nothing: the new draft records, per doc, which version it branches
// off, and the draft repo reads that until the doc's first edit clones it.
export async function forkDraft(
  repo: Repo,
  root: DocHandle<HasDrafts>,
  parentUrl: AutomergeUrl | null
): Promise<AutomergeUrl> {
  const clones = await forkPoints(repo, root.url, parentUrl);
  const mainDraft = await ensureMainDraft(repo, root);
  const parent = parentUrl ? await repo.find<DraftDoc>(parentUrl) : mainDraft;
  // Default names count up on the main draft, so numbers stay stable as
  // drafts are merged or deleted.
  let number = 1;
  mainDraft.change((d) => {
    d.draftCounter = (d.draftCounter ?? 0) + 1;
    number = d.draftCounter;
  });
  const draft = repo.create<DraftDoc>({
    "@patchwork": { type: "draft" },
    name: `Draft ${number}`,
    parent: parent.url,
    drafts: [],
    clones,
  });
  parent.change((d) => {
    d.drafts.push(draft.url);
  });
  return draft.url;
}

// Merge a draft into the draft it was forked off (main for a top-level one),
// and return where it landed: that draft, or null for main.
export async function mergeIntoParent(
  repo: Repo,
  draftUrl: AutomergeUrl
): Promise<AutomergeUrl | null> {
  const draft = await repo.find<DraftDoc>(draftUrl);
  await mergeDraft(repo, draft);
  return landedOn(repo, draft.doc()?.parent);
}

// Unlink a draft from its parent, which drops it, and every draft forked
// from it, out of the list. Nothing is merged and its docs stay where they
// are. Returns the parent, or null for main.
export async function deleteDraft(
  repo: Repo,
  draftUrl: AutomergeUrl
): Promise<AutomergeUrl | null> {
  const draft = await repo.find<DraftDoc>(draftUrl);
  const parentUrl = draft.doc()?.parent;
  if (!parentUrl) return null;
  const parent = await repo.find<DraftDoc>(parentUrl);
  parent.change((d) => {
    const i = d.drafts.indexOf(draftUrl);
    if (i >= 0) d.drafts.splice(i, 1);
  });
  return landedOn(repo, parentUrl);
}

// Rename a draft, or main (`draftUrl` null), which creates the main draft if
// there isn't one yet. An empty name goes back to the default label.
export async function renameDraft(
  repo: Repo,
  root: DocHandle<HasDrafts>,
  draftUrl: AutomergeUrl | null,
  name: string
): Promise<void> {
  const draft = draftUrl
    ? await repo.find<DraftDoc>(draftUrl)
    : await ensureMainDraft(repo, root);
  const trimmed = name.trim();
  draft.change((d) => {
    if (trimmed) d.name = trimmed;
    else delete d.name;
  });
}

// The draft to check out instead of one of `url`'s children: `url`, or the
// nearest ancestor that hasn't been merged away. Null for main.
async function landedOn(
  repo: Repo,
  url: AutomergeUrl | undefined
): Promise<AutomergeUrl | null> {
  const seen = new Set<AutomergeUrl>();
  let cursor = url;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const doc = (await repo.find<DraftDoc>(cursor)).doc();
    if (!doc || doc.isMain) return null;
    if (doc.mergedAt === undefined) return cursor;
    cursor = doc.parent;
  }
  return null;
}
