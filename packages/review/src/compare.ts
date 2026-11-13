import { getHeads, hasHeads, type Doc } from "@automerge/automerge/slim";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";

import { canonical, find, walkTree, type Node, type Tree } from "./tree.js";

// How a file differs. Compared with another draft: both drafts have it and
// it `differs`, whoever changed it, or only `ours` (the checked-out draft) or
// `theirs` has it. Merged into another draft, what the merge does to that
// draft's version: `added`, `removed`, `changed`, or changed where `both`
// drafts edited it. A folder takes the marks of what's beneath it.
export type Mark = CompareMark | MergeMark;
export type CompareMark = "differs" | "ours" | "theirs";
export type MergeMark = "added" | "removed" | "changed" | "both";

// A file or folder the checked-out draft doesn't have, linked from `parent`.
export type Ghost = {
  url: AutomergeUrl;
  name: string;
  type: string | undefined;
  folder: boolean;
  parent: AutomergeUrl;
};

export type Comparison = {
  files: Record<AutomergeUrl, Mark>;
  folders: Record<AutomergeUrl, Mark>;
  ghosts: Ghost[];
  // The files the other draft has: the compared one, or the merge's target
  // as it is now.
  theirFiles: Set<AutomergeUrl>;
  // Merging, the files the target has once the draft is merged in.
  afterFiles: Set<AutomergeUrl> | null;
  // The docs a change to which can change the comparison.
  watched: DocHandle<unknown>[];
};

/**
 * Every file that differs between the tree under `root` as `ours` reads it
 * and as `theirs` does, by content.
 */
export async function compareTrees(
  ours: Repo,
  theirs: Repo,
  root: AutomergeUrl
): Promise<Comparison> {
  const url = canonical(root);
  const [mine, yours] = await Promise.all([walkTree(ours, url), walkTree(theirs, url)]);
  const watched = [...folderHandles(mine), ...folderHandles(yours)];
  const files: Record<AutomergeUrl, Mark> = {};

  await Promise.all(
    union(fileUrls(mine), fileUrls(yours)).map(async (file) => {
      const [a, b] = await Promise.all([load(ours, mine, file), load(theirs, yours, file)]);
      watched.push(...handles(a, b));
      const mark = compared(a?.doc(), b?.doc());
      if (mark) files[file] = mark;
    })
  );

  const ghosts = ghostsOf(mine, yours);
  for (const ghost of ghosts) if (ghost.folder) files[ghost.url] ??= "theirs";
  return {
    files: withoutFolders(files, ghosts),
    folders: foldersHolding(files, ghosts, mine, yours),
    ghosts,
    theirFiles: new Set(fileUrls(yours)),
    afterFiles: null,
    watched,
  };
}

/**
 * What merging the checked-out draft (`ours`) into another does to that
 * draft's tree under `root`: `before` reads it as it is, `after` as the merge
 * would leave it.
 */
export async function compareMerge(
  ours: Repo,
  before: Repo,
  after: Repo,
  root: AutomergeUrl
): Promise<Comparison> {
  const url = canonical(root);
  const [mine, was, will] = await Promise.all([
    walkTree(ours, url),
    walkTree(before, url),
    walkTree(after, url),
  ]);
  const watched = [...folderHandles(mine), ...folderHandles(was)];
  const files: Record<AutomergeUrl, Mark> = {};

  await Promise.all(
    union(fileUrls(was), fileUrls(will)).map(async (file) => {
      const [a, b, c] = await Promise.all([
        load(before, was, file),
        load(after, will, file),
        load(ours, mine, file),
      ]);
      watched.push(...handles(a, c));
      const mark = merged(a?.doc(), b?.doc(), c?.doc());
      if (mark) files[file] = mark;
    })
  );

  const ghosts = [...ghostsOf(mine, will), ...ghostsOf(mine, was, will)];
  for (const ghost of ghosts) {
    if (ghost.folder) files[ghost.url] ??= will.has(ghost.url) ? "added" : "removed";
  }
  return {
    files: withoutFolders(files, ghosts),
    folders: foldersHolding(files, ghosts, mine, was, will),
    ghosts,
    theirFiles: new Set(fileUrls(was)),
    afterFiles: new Set(fileUrls(will)),
    watched,
  };
}

function compared(ours: unknown, theirs: unknown): CompareMark | null {
  if (!ours && !theirs) return null;
  if (!theirs) return "ours";
  if (!ours) return "theirs";
  return sameContent(ours, theirs) ? null : "differs";
}

// `ours` is the merging draft's version, which says whether both edited it.
function merged(before: unknown, after: unknown, ours: unknown): MergeMark | null {
  if (!before && !after) return null;
  if (!before) return "added";
  if (!after) return "removed";
  if (sameContent(before, after)) return null;
  return ours && editedByBoth(ours as Doc<unknown>, before as Doc<unknown>) ? "both" : "changed";
}

function editedByBoth(a: Doc<unknown>, b: Doc<unknown>): boolean {
  return !hasHeads(b, getHeads(a)) && !hasHeads(a, getHeads(b));
}

// The drafts' versions of a doc share their history, so the same heads are
// the same content; otherwise the content itself says.
function sameContent(a: unknown, b: unknown): boolean {
  const heads = getHeads(a as Doc<unknown>);
  const theirs = getHeads(b as Doc<unknown>);
  if (heads.length === theirs.length && heads.every((head) => theirs.includes(head))) return true;
  return equal(a, b);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    );
  }
  if (a instanceof Date || b instanceof Date) return a.valueOf() === b.valueOf();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return keys.every((key) => key in y && equal(x[key], y[key]));
}

// What `tree` has that neither `mine` nor any of `skipped` does.
function ghostsOf(mine: Tree, tree: Tree, ...skipped: Tree[]): Ghost[] {
  return [...tree].flatMap(([url, node]) =>
    !node.parent || mine.has(url) || skipped.some((other) => other.has(url))
      ? []
      : [ghost(url, node, node.parent)]
  );
}

function ghost(url: AutomergeUrl, node: Node, parent: AutomergeUrl): Ghost {
  return { url, name: node.name, type: node.type, folder: !!node.folder, parent };
}

function withoutFolders(
  files: Record<AutomergeUrl, Mark>,
  ghosts: Ghost[]
): Record<AutomergeUrl, Mark> {
  const folders = new Set(ghosts.flatMap((g) => (g.folder ? [g.url] : [])));
  return Object.fromEntries(
    Object.entries(files).filter(([url]) => !folders.has(url as AutomergeUrl))
  );
}

// A file's location runs through every folder above it, so a folder holds the
// marked files whose locations, in any tree, start with its own. A ghost
// folder holds its own mark too.
function foldersHolding(
  files: Record<AutomergeUrl, Mark>,
  ghosts: Ghost[],
  ...trees: Tree[]
): Record<AutomergeUrl, Mark> {
  const located = trees.flatMap((tree) =>
    Object.entries(files).flatMap(([url, mark]) => {
      const node = tree.get(url as AutomergeUrl);
      return node ? [{ location: node.location, mark }] : [];
    })
  );
  const folders: Record<AutomergeUrl, Mark> = {};
  for (const g of ghosts) {
    const mark = files[g.url];
    if (g.folder && mark) folders[g.url] = mark;
  }
  for (const tree of trees) {
    for (const [url, node] of tree) {
      if (!node.folder || !node.path) continue;
      const prefix = `${node.location}/`;
      for (const file of located) {
        if (!file.location.startsWith(prefix)) continue;
        const was = folders[url];
        folders[url] = was ? combined(was, file.mark) : file.mark;
      }
    }
  }
  return folders;
}

// A folder holding files marked differently.
function combined(a: Mark, b: Mark): Mark {
  if (a === b) return a;
  if (isCompareMark(a) && isCompareMark(b)) return "differs";
  return a === "both" || b === "both" ? "both" : "changed";
}

function isCompareMark(mark: Mark): mark is CompareMark {
  return mark === "differs" || mark === "ours" || mark === "theirs";
}

async function load(repo: Repo, tree: Tree, url: AutomergeUrl) {
  return tree.has(url) ? find(repo, url) : null;
}

function handles(...found: (DocHandle<unknown> | null)[]): DocHandle<unknown>[] {
  return found.filter((handle): handle is DocHandle<unknown> => !!handle);
}

function union<T>(...lists: T[][]): T[] {
  return [...new Set(lists.flat())];
}

function fileUrls(tree: Tree): AutomergeUrl[] {
  return [...tree].flatMap(([url, node]) => (node.folder ? [] : [url]));
}

function folderHandles(tree: Tree): DocHandle<unknown>[] {
  return [...tree.values()].flatMap((node) => (node.folder ? [node.folder] : []));
}
