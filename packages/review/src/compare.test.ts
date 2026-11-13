import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";

import { compareMerge, compareTrees } from "./compare.js";
import { linksOf } from "./tree.js";

type File = { content: string };
type Folder = { docs: { url: AutomergeUrl; type: string; name: string }[] };
// The docs a draft has cloned, by the url it's read by.
type Clones = Map<AutomergeUrl, DocHandle<unknown>>;

beforeAll(() => {
  initSubduction();
});

describe("linksOf", () => {
  it("reads a pushwork directory doc's paths", () => {
    const repo = new Repo();
    const file = repo.create<File>({ content: "" });
    const links = linksOf({ "@patchwork": { type: "directory" }, "a/b.txt": file.url });
    expect(links).toEqual([{ url: file.url, name: "a/b.txt", folder: false }]);
  });
});

describe("compareTrees", () => {
  it("marks the files whose content differs, whoever changed them", async () => {
    const base = new Repo();
    const mine = base.create<File>({ content: "a" });
    const yours = base.create<File>({ content: "b" });
    const shared = base.create<File>({ content: "c" });
    const alike = base.create<File>({ content: "d" });
    const root = folder(base, { mine, yours, shared, alike });
    const ours: Clones = new Map();
    const theirs: Clones = new Map();
    edit(base, ours, mine, "A");
    edit(base, theirs, yours, "B");
    edit(base, ours, shared, "C1");
    edit(base, theirs, shared, "C2");
    edit(base, ours, alike, "D");
    edit(base, theirs, alike, "D");

    const { files } = await compareTrees(through(base, ours), through(base, theirs), root.url);
    expect(files).toEqual({
      [mine.url]: "differs",
      [yours.url]: "differs",
      [shared.url]: "differs",
    });
  });

  it("marks a file only one draft has as that draft's, and ghosts theirs", async () => {
    const base = new Repo();
    const kept = base.create<File>({ content: "a" });
    const added = base.create<File>({ content: "new" });
    const inner = base.create<File>({ content: "inner" });
    const box = folder(base, { inner });
    const root = folder(base, { kept });
    const theirs: Clones = new Map();
    clone(base, theirs, root).change((d) => {
      d.docs.push({ url: added.url, type: "txt", name: "added" });
      d.docs.push({ url: box.url, type: "folder", name: "box" });
    });

    const result = await compareTrees(through(base, new Map()), through(base, theirs), root.url);
    expect(result.files).toEqual({ [added.url]: "theirs", [inner.url]: "theirs" });
    expect(result.folders).toEqual({ [box.url]: "theirs" });
    expect(result.theirFiles).toEqual(new Set([kept.url, added.url, inner.url]));
    expect(result.ghosts).toEqual(
      expect.arrayContaining([
        { url: added.url, name: "added", type: "txt", folder: false, parent: root.url },
        { url: box.url, name: "box", type: "folder", folder: true, parent: root.url },
        { url: inner.url, name: "inner", type: "txt", folder: false, parent: box.url },
      ])
    );
    expect(result.ghosts).toHaveLength(3);
  });

  it("marks the folders a change is beneath with whose changes they hold", async () => {
    const base = new Repo();
    const a = base.create<File>({ content: "a" });
    const b = base.create<File>({ content: "b" });
    const left = folder(base, { a });
    const right = folder(base, { b });
    const quiet = folder(base, {});
    const outer = base.create<Folder>({
      docs: [
        { url: left.url, type: "folder", name: "left" },
        { url: right.url, type: "folder", name: "right" },
      ],
    });
    const root = base.create<Folder>({
      docs: [
        { url: outer.url, type: "folder", name: "outer" },
        { url: quiet.url, type: "folder", name: "quiet" },
      ],
    });
    const ours: Clones = new Map();
    const theirs: Clones = new Map();
    edit(base, ours, a, "A");
    edit(base, theirs, b, "B");

    const { folders } = await compareTrees(through(base, ours), through(base, theirs), root.url);
    expect(folders).toEqual({
      [left.url]: "differs",
      [right.url]: "differs",
      [outer.url]: "differs",
    });
  });
});

describe("compareMerge", () => {
  it("says what merging does to the target's files", async () => {
    const base = new Repo();
    const kept = base.create<File>({ content: "kept" });
    const edited = base.create<File>({ content: "edited" });
    const shared = base.create<File>({ content: "shared" });
    const theirsOnly = base.create<File>({ content: "theirs" });
    const dropped = base.create<File>({ content: "dropped" });
    const added = base.create<File>({ content: "added" });
    const root = folder(base, { kept, edited, shared, theirsOnly, dropped });
    const ours: Clones = new Map();
    const before: Clones = new Map();
    edit(base, ours, edited, "EDITED");
    edit(base, ours, shared, "ours");
    edit(base, before, shared, "theirs");
    edit(base, before, theirsOnly, "THEIRS");
    clone(base, ours, root).change((d) => {
      d.docs.splice(d.docs.findIndex((entry) => entry.url === dropped.url), 1);
      d.docs.push({ url: added.url, type: "txt", name: "added" });
    });

    const after = merged(base, before, ours);
    const result = await compareMerge(
      through(base, ours),
      through(base, before),
      through(base, after),
      root.url
    );
    expect(result.files).toEqual({
      [edited.url]: "changed",
      [shared.url]: "both",
      [dropped.url]: "removed",
      [added.url]: "added",
    });
    expect(result.ghosts.map((ghost) => ghost.url)).toEqual([dropped.url]);
    expect(result.afterFiles?.has(dropped.url)).toBe(false);
  });
});

// What the target's docs are once `ours` is merged in.
function merged(base: Repo, target: Clones, ours: Clones): Clones {
  const after: Clones = new Map(target);
  for (const [url, copy] of ours) {
    const into = base.clone((target.get(url) ?? copy) as DocHandle<unknown>);
    into.merge(copy);
    after.set(url, into);
  }
  return after;
}

function folder(repo: Repo, files: Record<string, DocHandle<unknown>>): DocHandle<Folder> {
  return repo.create<Folder>({
    docs: Object.entries(files).map(([name, file]) => ({ url: file.url, type: "txt", name })),
  });
}

function edit(repo: Repo, clones: Clones, handle: DocHandle<File>, content: string) {
  clone(repo, clones, handle).change((d) => {
    d.content = content;
  });
}

function clone<T>(repo: Repo, clones: Clones, handle: DocHandle<T>): DocHandle<T> {
  const copy = repo.clone(handle);
  clones.set(handle.url, copy as DocHandle<unknown>);
  return copy;
}

// Reads docs the way a draft repo does: a cloned doc from its clone.
function through(base: Repo, clones: Clones): Repo {
  return {
    find: async (id: AnyDocumentId) => clones.get(id as AutomergeUrl) ?? base.find(id),
  } as unknown as Repo;
}
