import { getHeads, hasHeads, type Doc } from "@automerge/automerge/slim";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";

import { canonical, find, walkTree, type Tree } from "./tree.js";

// Which draft has changes to a file that the other doesn't: ours (the
// checked-out draft), theirs (the compared one), or both. A file only one of
// them has is that one's.
export type Side = "ours" | "theirs" | "both";

export type Comparison = {
  files: Record<AutomergeUrl, Side>;
  // The folders with a changed file somewhere beneath them, and whose.
  folders: Record<AutomergeUrl, Side>;
  // The files the compared draft has, changed or not.
  theirFiles: Set<AutomergeUrl>;
  // The docs a change to which can change the comparison.
  watched: DocHandle<unknown>[];
};

/**
 * Every file that differs between the tree under `root` as `ours` reads it
 * and as `theirs` does. Both repos read through a draft of the same
 * workspace, so a file's two versions share their history and their heads say
 * which has what.
 */
export async function compareTrees(
  ours: Repo,
  theirs: Repo,
  root: AutomergeUrl
): Promise<Comparison> {
  const url = canonical(root);
  const [mine, yours] = await Promise.all([walkTree(ours, url), walkTree(theirs, url)]);
  const watched = [...folderHandles(mine), ...folderHandles(yours)];
  const files: Record<AutomergeUrl, Side> = {};
  const urls = new Set([...fileUrls(mine), ...fileUrls(yours)]);

  await Promise.all(
    [...urls].map(async (file) => {
      const [a, b] = await Promise.all([
        mine.has(file) ? find(ours, file) : null,
        yours.has(file) ? find(theirs, file) : null,
      ]);
      if (a) watched.push(a);
      if (b) watched.push(b);
      const side = sideOf(a?.doc() as Doc<unknown> | undefined, b?.doc() as Doc<unknown> | undefined);
      if (side) files[file] = side;
    })
  );

  return {
    files,
    folders: foldersHolding(files, mine, yours),
    theirFiles: new Set(fileUrls(yours)),
    watched,
  };
}

export function sideOf(
  ours: Doc<unknown> | undefined,
  theirs: Doc<unknown> | undefined
): Side | null {
  if (!ours && !theirs) return null;
  if (!theirs) return "ours";
  if (!ours) return "theirs";
  const ahead = !hasHeads(theirs, getHeads(ours));
  const behind = !hasHeads(ours, getHeads(theirs));
  if (ahead && behind) return "both";
  return ahead ? "ours" : behind ? "theirs" : null;
}

// A file's location runs through every folder above it, so a folder holds the
// changed files whose locations, in either tree, start with its own.
function foldersHolding(
  files: Record<AutomergeUrl, Side>,
  ...trees: Tree[]
): Record<AutomergeUrl, Side> {
  const located = trees.flatMap((tree) =>
    Object.entries(files).flatMap(([url, side]) => {
      const node = tree.get(url as AutomergeUrl);
      return node ? [{ location: node.location, side }] : [];
    })
  );
  const folders: Record<AutomergeUrl, Side> = {};
  for (const tree of trees) {
    for (const [url, node] of tree) {
      if (!node.folder || !node.path) continue;
      const prefix = `${node.location}/`;
      for (const file of located) {
        if (!file.location.startsWith(prefix)) continue;
        const was = folders[url];
        folders[url] = !was || was === file.side ? file.side : "both";
      }
    }
  }
  return folders;
}

function fileUrls(tree: Tree): AutomergeUrl[] {
  return [...tree].flatMap(([url, node]) => (node.folder ? [] : [url]));
}

function folderHandles(tree: Tree): DocHandle<unknown>[] {
  return [...tree.values()].flatMap((node) => (node.folder ? [node.folder] : []));
}
