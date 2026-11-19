import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import type {
  CloneEntry,
  DraftDoc,
  GitRemoteConfig,
  HasDrafts,
  SyncPoint,
} from "../draft-types.js";
import { ensureMainDraft } from "../draft-docs.js";
import { mergeDraft } from "../draft-forks.js";
import {
  changesFrom,
  currentVersion,
  frontier,
  importTree,
  isAncestor,
  readFiles,
  sameHeads,
  type Line,
  type Snapshot,
} from "./files.js";
import {
  GitError,
  validBranchName,
  type CommitInfo,
  type Remote,
  type TreeEntry,
} from "./remote.js";

// Syncing a workspace's drafts with git branches, one deliberate action at a
// time. Main syncs with the repo's branch (`remote.branch` on the main
// draft); any other draft with the branch of its own name, once linked.
//
// A sync point is a commit and the draft's heads when both sides agreed on
// it. Syncing finds the draft's latest one, S, then:
//   - git moved (the branch's tip isn't S): import S's tree → the tip's,
//     written as of S's heads, so edits made here since merge with it;
//   - the draft moved (its heads aren't the latest sync point's): export its
//     files as one commit on the tip, fast-forward only.
// Each step records a sync point once it's done (an export only once the
// push went through).

export type GitContext = {
  repo: Repo;
  // the workspace folder
  root: DocHandle<HasDrafts>;
  remote: Remote;
};

export type LineStatus =
  | { kind: "not-connected" }
  | { kind: "unlinked"; branch: string; problem?: string }
  | {
      kind: "linked";
      branch: string;
      synced: { sha: string; at: number };
      // paths changed here since, and commits on the branch since
      local: string[];
      incoming: CommitInfo[];
      // the branch no longer descends from the last sync: someone rewrote it
      rewritten: boolean;
      // gone from the remote
      missing: boolean;
      // a commit was recorded twice: it may have been imported twice
      duplicate: boolean;
    };

export type SyncResult = {
  imported: string[];
  exported: string[];
  sha: string;
  // drafts merged on the git side, and merged here as part of the sync
  merged: AutomergeUrl[];
};

// --- Lines --------------------------------------------------------------------

export async function mainDraft(ctx: GitContext): Promise<DocHandle<DraftDoc>> {
  return ensureMainDraft(ctx.repo, ctx.root);
}

export function remoteConfig(main: DocHandle<DraftDoc>): GitRemoteConfig | undefined {
  return main.doc()?.remote;
}

// The branch a draft (null: main) syncs with.
function branchOf(main: DocHandle<DraftDoc>, draft: DocHandle<DraftDoc> | null): string {
  if (!draft || draft.doc()?.isMain) return remoteConfig(main)!.branch;
  return draft.doc()?.name ?? "";
}

function lineOf(ctx: GitContext, draft: DocHandle<DraftDoc> | null): Line {
  return {
    repo: ctx.repo,
    root: ctx.root.url,
    draft: draft && !draft.doc()?.isMain ? draft : null,
  };
}

// Where a line's sync points are kept: the draft, or main's on the main draft.
function stateOf(main: DocHandle<DraftDoc>, draft: DocHandle<DraftDoc> | null) {
  return draft && !draft.doc()?.isMain ? draft : main;
}

export function syncPoints(state: DocHandle<DraftDoc>): SyncPoint[] {
  return Object.values(state.doc()?.git?.syncPoints ?? {}).sort((a, b) => b.at - a.at);
}

function latest(state: DocHandle<DraftDoc>): SyncPoint | undefined {
  return syncPoints(state)[0];
}

function record(state: DocHandle<DraftDoc>, point: Omit<SyncPoint, "at">): SyncPoint {
  // Heads read out of a doc are its objects: copied, so they can be written
  // into another.
  const full: SyncPoint = JSON.parse(JSON.stringify({ ...point, at: Date.now() }));
  const id = Math.random().toString(36).slice(2, 10);
  state.change((d) => {
    d.git ??= { syncPoints: {} };
    d.git.syncPoints[`${point.sha}/${id}`] = full;
  });
  return full;
}

// --- Connecting main ------------------------------------------------------------

// Link the workspace's main with `config.branch` of a repo. Files only on the
// branch are copied in; then the workspace's files are committed on top, so
// where both have a file, the workspace's wins.
export async function connect(
  ctx: GitContext,
  config: GitRemoteConfig,
  message: string,
): Promise<SyncResult> {
  const main = await mainDraft(ctx);
  if (remoteConfig(main)) throw new GitError("This workspace is already connected to git.");
  const tip = await ctx.remote.tip(config.branch);
  if (!tip) {
    throw new GitError(
      `There's no branch “${config.branch}”. If the repository is empty, make a first commit on GitHub (a README is enough).`,
    );
  }
  main.change((d) => {
    d.remote = { ...config };
    d.git = { syncPoints: {} };
  });
  const line = lineOf(ctx, null);
  const tree = await ctx.remote.treeOf(tip);
  const entries = await ctx.remote.readTree(tree);
  const now = await readFiles(line);
  const { touched } = await importTree(line, ctx.remote, now.heads, entries, {
    addOnly: true,
  });
  const exported = await exportLine(ctx, main, null, { sha: tip, tree }, entries, message, []);
  return {
    imported: touched,
    exported: exported.paths,
    sha: exported.sha,
    merged: [],
  };
}

// Forget the repo, and main's sync points with it. Connecting again starts
// over, as the first connect did.
export async function disconnect(ctx: GitContext): Promise<void> {
  const main = await mainDraft(ctx);
  main.change((d) => {
    delete d.remote;
    delete d.git;
  });
}

// --- Status ---------------------------------------------------------------------

export async function status(
  ctx: GitContext,
  draft: DocHandle<DraftDoc> | null,
): Promise<LineStatus> {
  const main = await mainDraft(ctx);
  if (!remoteConfig(main)) return { kind: "not-connected" };
  const state = stateOf(main, draft);
  const branch = branchOf(main, draft);
  const last = latest(state);
  if (!last) {
    if (state === main) return { kind: "not-connected" };
    return {
      kind: "unlinked",
      branch,
      problem: await publishProblem(ctx, main, draft!),
    };
  }
  const line = lineOf(ctx, draft);
  const [tip, now, tree] = await Promise.all([
    ctx.remote.tip(branch),
    readFiles(line),
    ctx.remote.readTree(last.tree),
  ]);
  const local = (await changesFrom(tree, now, ctx.remote)).map((change) => change.path);
  const duplicate = syncPoints(state).filter((point) => point.sha === last.sha).length > 1;
  const base = {
    kind: "linked" as const,
    branch,
    synced: { sha: last.sha, at: last.at },
    local,
    duplicate,
  };
  if (!tip) return { ...base, incoming: [], rewritten: false, missing: true };
  if (tip === last.sha) return { ...base, incoming: [], rewritten: false, missing: false };
  const { relation, commits } = await ctx.remote.compare(last.sha, tip);
  return {
    ...base,
    incoming: relation === "ahead" ? commits : [],
    rewritten: relation !== "ahead",
    missing: false,
  };
}

// --- Syncing --------------------------------------------------------------------

export async function sync(
  ctx: GitContext,
  draft: DocHandle<DraftDoc> | null,
  message: string,
): Promise<SyncResult> {
  const main = await mainDraft(ctx);
  if (!remoteConfig(main)) throw new GitError("This workspace isn't connected to git.");
  const state = stateOf(main, draft);
  const branch = branchOf(main, draft);
  const last = latest(state);
  if (!last) throw new GitError(`“${branch}” isn't linked to a branch yet.`);
  const line = lineOf(ctx, draft);

  const tip = await ctx.remote.tip(branch);
  if (!tip) throw new GitError(`The branch “${branch}” is gone from the repository.`);

  let base = last;
  let imported: string[] = [];
  const merged: AutomergeUrl[] = [];
  if (tip !== last.sha) {
    const { relation, commits } = await ctx.remote.compare(last.sha, tip);
    if (relation !== "ahead") {
      throw new GitError(
        `“${branch}” was rewritten on the git side (force-pushed or rebased). Syncing rewritten branches isn't supported yet.`,
      );
    }
    let anchor = last.heads;
    if (state === main) {
      const landed = await mergedOnGit(ctx, main, last, commits);
      for (const { handle, point } of landed) {
        await mergeDraft(ctx.repo, handle, main);
        anchor = await union(ctx, anchor, point.heads);
        merged.push(handle.url);
      }
    }
    const tree = await ctx.remote.treeOf(tip);
    const entries = await ctx.remote.readTree(tree);
    const now = await readFiles(line);
    if (await matches(now, entries, ctx.remote)) {
      // Already here: an export whose sync point never got recorded, or a sync
      // someone else made that hasn't reached its record yet.
      base = record(state, { sha: tip, tree, heads: now.heads });
    } else {
      const result = await importTree(line, ctx.remote, anchor, entries);
      imported = result.touched;
      base = record(state, { sha: tip, tree, heads: result.heads });
    }
  }

  const entries = await ctx.remote.readTree(base.tree);
  const extra = state === main ? Object.keys(main.doc()?.git?.mergedBranches ?? {}) : [];
  const exported = await exportLine(ctx, state, draft, base, entries, message, extra);
  return { imported, exported: exported.paths, sha: exported.sha, merged };
}

// Commit the line's files on top of `base` and move the branch there. With
// nothing to commit, it just records that the two agree.
async function exportLine(
  ctx: GitContext,
  state: DocHandle<DraftDoc>,
  draft: DocHandle<DraftDoc> | null,
  base: { sha: string; tree: string; heads?: Record<AutomergeUrl, UrlHeads> },
  entries: TreeEntry[],
  message: string,
  extraParents: string[],
): Promise<{ sha: string; paths: string[] }> {
  const main = await mainDraft(ctx);
  const branch = branchOf(main, draft);
  const now = await readFiles(lineOf(ctx, draft));
  if (base.heads && sameHeadsMap(base.heads, now.heads) && !extraParents.length) {
    return { sha: base.sha, paths: [] };
  }
  const changes = await changesFrom(entries, now, ctx.remote);
  const parents = [base.sha];
  for (const sha of extraParents) {
    if (sha === base.sha) continue;
    const { relation } = await ctx.remote.compare(sha, base.sha);
    if (relation === "diverged" || relation === "behind") parents.push(sha);
  }
  const done = (point: Omit<SyncPoint, "at">) => {
    record(state, point);
    if (extraParents.length) {
      state.change((d) => {
        if (d.git) delete d.git.mergedBranches;
      });
    }
  };
  if (!changes.length && parents.length === 1) {
    done({ sha: base.sha, tree: base.tree, heads: now.heads });
    return { sha: base.sha, paths: [] };
  }
  const commit = await ctx.remote.commit({
    parents,
    baseTree: base.tree,
    changes,
    message: message.trim() || defaultMessage(changes.map((c) => c.path)),
  });
  if (!(await ctx.remote.moveBranch(branch, commit.sha))) {
    throw new GitError(`“${branch}” moved on the git side while syncing. Sync again.`);
  }
  done({ sha: commit.sha, tree: commit.tree, heads: now.heads });
  return { sha: commit.sha, paths: changes.map((c) => c.path) };
}

function defaultMessage(paths: string[]): string {
  if (paths.length === 0) return "Merge";
  if (paths.length === 1) return `Update ${paths[0]}`;
  return `Update ${paths.length} files`;
}

// Whether the snapshot's files are exactly those of the tree.
async function matches(now: Snapshot, entries: TreeEntry[], remote: Remote): Promise<boolean> {
  return (await changesFrom(entries, now, remote)).length === 0;
}

function sameHeadsMap(
  a: Record<AutomergeUrl, UrlHeads>,
  b: Record<AutomergeUrl, UrlHeads>,
): boolean {
  const keys = Object.keys(b) as AutomergeUrl[];
  return keys.length === Object.keys(a).length && keys.every((url) => sameHeads(a[url], b[url]));
}

// The linked drafts whose branches the git side merged into main since `last`:
// those whose latest sync commit is among the commits main gained.
async function mergedOnGit(
  ctx: GitContext,
  main: DocHandle<DraftDoc>,
  last: SyncPoint,
  commits: CommitInfo[],
): Promise<{ handle: DocHandle<DraftDoc>; point: SyncPoint }[]> {
  const parents = new Set(commits.flatMap((commit) => [commit.sha, ...commit.parents]));
  const landed: { handle: DocHandle<DraftDoc>; point: SyncPoint }[] = [];
  for (const url of main.doc()?.drafts ?? []) {
    if (!isValidAutomergeUrl(url)) continue;
    const handle = await ctx.repo.find<DraftDoc>(url);
    const doc = handle.doc();
    if (!doc || doc.mergedAt !== undefined || doc.preview) continue;
    const point = latest(handle);
    if (!point || point.sha === last.sha || !parents.has(point.sha)) continue;
    landed.push({ handle, point });
  }
  return landed;
}

// Both versions at once, per doc: what main holds after merging a draft in.
async function union(
  ctx: GitContext,
  a: Record<AutomergeUrl, UrlHeads>,
  b: Record<AutomergeUrl, UrlHeads>,
): Promise<Record<AutomergeUrl, UrlHeads>> {
  const out = { ...a };
  for (const [url, heads] of Object.entries(b) as [AutomergeUrl, UrlHeads][]) {
    if (!out[url]) {
      out[url] = heads;
      continue;
    }
    const doc = (await ctx.repo.find<unknown>(url)).doc();
    out[url] = frontier(doc as never, [...out[url], ...heads] as UrlHeads);
  }
  return out;
}

// --- Drafts and branches --------------------------------------------------------

// Make a branch of the draft's name and link the draft with it: the branch
// starts at the latest commit of main's that the draft was copied after, and
// gets the draft's files as one commit.
export async function publishDraft(
  ctx: GitContext,
  draft: DocHandle<DraftDoc>,
  message: string,
): Promise<SyncResult> {
  const main = await mainDraft(ctx);
  const problem = await publishProblem(ctx, main, draft);
  if (problem) throw new GitError(problem);
  const base = (await mainPointUnder(ctx, main, draft))!;
  const branch = branchOf(main, draft);
  const entries = await ctx.remote.readTree(base.tree);
  const now = await readFiles(lineOf(ctx, draft));
  const changes = await changesFrom(entries, now, ctx.remote);
  const commit = changes.length
    ? await ctx.remote.commit({
        parents: [base.sha],
        baseTree: base.tree,
        changes,
        message: message.trim() || defaultMessage(changes.map((c) => c.path)),
      })
    : { sha: base.sha, tree: base.tree };
  if (!(await ctx.remote.createBranch(branch, commit.sha))) {
    throw new GitError(`There's already a branch “${branch}”.`);
  }
  draft.change((d) => {
    d.git ??= { syncPoints: {} };
  });
  record(draft, { sha: commit.sha, tree: commit.tree, heads: now.heads });
  return {
    imported: [],
    exported: changes.map((c) => c.path),
    sha: commit.sha,
    merged: [],
  };
}

// Why the draft can't get a branch yet, if it can't.
async function publishProblem(
  ctx: GitContext,
  main: DocHandle<DraftDoc>,
  draft: DocHandle<DraftDoc>,
): Promise<string | undefined> {
  const doc = draft.doc();
  const name = doc?.name ?? "";
  if (doc?.parent !== main.url) {
    return "Only drafts copied from main can have a branch for now.";
  }
  if (!validBranchName(name)) {
    return `“${name}” can't be a branch name. Rename the draft: no spaces, and none of ~ ^ : ? * [ \\.`;
  }
  if (await ctx.remote.tip(name)) {
    return `There's already a branch “${name}”. Rename the draft, or open that branch as a draft of its own.`;
  }
  if (!(await mainPointUnder(ctx, main, draft))) {
    return "This draft was copied from main before main was synced with git. Make a new draft from main to put on a branch.";
  }
  return undefined;
}

// The latest of main's sync points the draft has everything of.
async function mainPointUnder(
  ctx: GitContext,
  main: DocHandle<DraftDoc>,
  draft: DocHandle<DraftDoc>,
): Promise<SyncPoint | undefined> {
  const line = lineOf(ctx, draft);
  for (const point of syncPoints(main)) {
    let under = true;
    for (const [url, heads] of Object.entries(point.heads) as [AutomergeUrl, UrlHeads][]) {
      const current = await currentVersion(line, url);
      if (!isAncestor(current.doc, heads, current.heads)) {
        under = false;
        break;
      }
    }
    if (under) return point;
  }
  return undefined;
}

// Branches that could become drafts: not main's, and not a draft's already.
export async function openableBranches(ctx: GitContext): Promise<string[]> {
  const main = await mainDraft(ctx);
  const config = remoteConfig(main);
  if (!config) return [];
  const taken = new Set([config.branch]);
  for (const url of main.doc()?.drafts ?? []) {
    if (!isValidAutomergeUrl(url)) continue;
    const doc = (await ctx.repo.find<DraftDoc>(url)).doc();
    if (doc?.name && doc.mergedAt === undefined) taken.add(doc.name);
  }
  return (await ctx.remote.branches()).filter((name) => !taken.has(name)).sort();
}

// A new draft for a branch: copied from main as of the latest sync point the
// branch descends from, with the branch's changes since imported.
export async function openBranch(ctx: GitContext, branch: string): Promise<AutomergeUrl> {
  const main = await mainDraft(ctx);
  const tip = await ctx.remote.tip(branch);
  if (!tip) throw new GitError(`There's no branch “${branch}”.`);
  let base: SyncPoint | undefined;
  for (const point of syncPoints(main)) {
    const { relation } = await ctx.remote.compare(point.sha, tip);
    if (relation === "ahead" || relation === "identical") {
      base = point;
      break;
    }
  }
  if (!base) {
    throw new GitError(
      `“${branch}” doesn't start from a version of main that's been synced here. Sync main, then try again.`,
    );
  }
  const clones: Record<AutomergeUrl, CloneEntry> = {};
  for (const [url, heads] of Object.entries(base.heads) as [AutomergeUrl, UrlHeads][]) {
    clones[url] = { clonedAt: heads };
  }
  const draft = ctx.repo.create<DraftDoc>({
    "@patchwork": { type: "draft" },
    name: branch,
    parent: main.url,
    drafts: [],
    clones,
    git: { syncPoints: {} },
  });
  main.change((d) => {
    d.drafts.push(draft.url);
  });
  const tree = await ctx.remote.treeOf(tip);
  const entries = await ctx.remote.readTree(tree);
  const { heads } = await importTree(lineOf(ctx, draft), ctx.remote, base.heads, entries);
  record(draft, { sha: tip, tree, heads });
  return draft.url;
}

// A linked draft merged into main here: main's next export becomes the merge
// commit of the draft's branch.
export async function noteMerge(
  ctx: GitContext,
  draft: DocHandle<DraftDoc>,
  into: DocHandle<DraftDoc> | null,
): Promise<void> {
  const main = await mainDraft(ctx);
  if (into && !into.doc()?.isMain) return;
  const point = latest(draft);
  if (!point) return;
  main.change((d) => {
    d.git ??= { syncPoints: {} };
    d.git.mergedBranches ??= {};
    d.git.mergedBranches[point.sha] = true;
  });
}
