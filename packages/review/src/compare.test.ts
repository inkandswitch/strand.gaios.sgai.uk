import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";

import { compareTrees } from "./compare.js";
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
  it("says whose changes each differing file has", async () => {
    const base = new Repo();
    const mine = base.create<File>({ content: "a" });
    const yours = base.create<File>({ content: "b" });
    const shared = base.create<File>({ content: "c" });
    const same = base.create<File>({ content: "d" });
    const root = folder(base, { mine, yours, shared, same });
    const ours: Clones = new Map();
    const theirs: Clones = new Map();
    edit(base, ours, mine, "A");
    edit(base, theirs, yours, "B");
    edit(base, ours, shared, "C1");
    edit(base, theirs, shared, "C2");

    const { files } = await compareTrees(through(base, ours), through(base, theirs), root.url);
    expect(files).toEqual({ [mine.url]: "ours", [yours.url]: "theirs", [shared.url]: "both" });
  });

  it("gives a file only one draft has to that draft", async () => {
    const base = new Repo();
    const kept = base.create<File>({ content: "a" });
    const added = base.create<File>({ content: "new" });
    const root = folder(base, { kept });
    const theirs: Clones = new Map();
    clone(base, theirs, root).change((d) => {
      d.docs.push({ url: added.url, type: "txt", name: "added" });
    });

    const result = await compareTrees(through(base, new Map()), through(base, theirs), root.url);
    expect(result.files).toEqual({ [added.url]: "theirs" });
    expect(result.theirFiles).toEqual(new Set([kept.url, added.url]));
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
    expect(folders).toEqual({ [left.url]: "ours", [right.url]: "theirs", [outer.url]: "both" });
  });
});

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
