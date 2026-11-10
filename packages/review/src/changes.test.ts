import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";

import { countLines, linksOf, reviewDraft, textOf, type DraftDoc } from "./changes.js";

type File = { content: string };
type Folder = { docs: { url: AutomergeUrl; type: string; name: string }[] };

beforeAll(() => {
  initSubduction();
});

describe("countLines", () => {
  it("counts the lines a change added and removed", () => {
    expect(countLines("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  });

  it("has nothing to count when either side isn't text", () => {
    expect(countLines(null, "a")).toBeNull();
  });
});

describe("textOf", () => {
  it("reads text stored as bytes, but not binary", () => {
    expect(textOf({ content: new TextEncoder().encode("hi") })).toBe("hi");
    expect(textOf({ content: new Uint8Array([0xff, 0xfe]) })).toBeNull();
  });
});

describe("linksOf", () => {
  it("reads a pushwork directory doc's paths", () => {
    const repo = new Repo();
    const file = repo.create<File>({ content: "" });
    const links = linksOf({ "@patchwork": { type: "directory" }, "a/b.txt": file.url });
    expect(links).toEqual([{ url: file.url, name: "a/b.txt", folder: false }]);
  });
});

describe("reviewDraft", () => {
  it("reports files the draft edited, added and removed", async () => {
    const base = new Repo();
    const edited = base.create<File>({ content: "one\ntwo\n" });
    const untouched = base.create<File>({ content: "same\n" });
    const removed = base.create<File>({ content: "gone\nfor good\n" });
    const root = base.create<Folder>({
      docs: [
        { url: edited.url, type: "txt", name: "edited.txt" },
        { url: untouched.url, type: "txt", name: "untouched.txt" },
        { url: removed.url, type: "txt", name: "removed.txt" },
      ],
    });

    const draft: DraftDoc = { clones: {} };
    const editedClone = fork(base, draft, edited);
    editedClone.change((d) => {
      d.content = "one\n2\nthree\n";
    });
    const added = base.create<File>({ content: "new\n" });
    draft.clones![added.url] = { cloneUrl: added.url, clonedAt: [] as never };
    const rootClone = fork(base, draft, root);
    rootClone.change((d) => {
      d.docs.splice(2, 1);
      d.docs.push({ url: added.url, type: "txt", name: "added.txt" });
    });

    const { changes } = await reviewDraft(throughDraft(base, draft), root.url, draft);

    const at = (name: string) => `${root.url}/${name}`;
    expect(changes).toEqual([
      { url: added.url, path: "added.txt", location: at("added.txt"), status: "added", added: 1, removed: 0 },
      { url: edited.url, path: "edited.txt", location: at("edited.txt"), status: "modified", added: 2, removed: 1 },
      { url: removed.url, path: "removed.txt", location: at("removed.txt"), status: "deleted", added: 0, removed: 2 },
    ]);
  });

  it("locates a file the way the project frame opens it", async () => {
    const base = new Repo();
    const file = base.create<File>({ content: "a\n" });
    const twin = base.create<File>({ content: "b\n" });
    const sub = base.create<Folder>({
      docs: [
        { url: file.url, type: "txt", name: "notes" },
        { url: twin.url, type: "txt", name: "notes" },
      ],
    });
    const root = base.create<Folder>({
      docs: [{ url: sub.url, type: "folder", name: "my docs" }],
    });
    const draft: DraftDoc = { clones: {} };
    fork(base, draft, file).change((d) => {
      d.content = "c\n";
    });

    const { changes } = await reviewDraft(throughDraft(base, draft), root.url, draft);
    expect(changes.map((c) => [c.path, c.location])).toEqual([
      ["my docs/notes", `${root.url}/my%20docs/${file.documentId}`],
    ]);
  });

  it("leaves out a file edited back to how it was", async () => {
    const base = new Repo();
    const file = base.create<File>({ content: "a\n" });
    const root = base.create<Folder>({
      docs: [{ url: file.url, type: "txt", name: "a.txt" }],
    });
    const draft: DraftDoc = { clones: {} };
    const clone = fork(base, draft, file);
    clone.change((d) => {
      d.content = "b\n";
    });
    clone.change((d) => {
      d.content = "a\n";
    });

    const { changes } = await reviewDraft(throughDraft(base, draft), root.url, draft);
    expect(changes).toEqual([]);
  });
});

// A draft's clone of `handle`, recorded the way the drafts package records it.
function fork<T>(repo: Repo, draft: DraftDoc, handle: DocHandle<T>): DocHandle<T> {
  const clone = repo.clone(handle);
  draft.clones![handle.url] = { cloneUrl: clone.url, clonedAt: handle.heads() };
  return clone;
}

// Reads docs the way a draft repo does: a cloned doc from its clone.
function throughDraft(base: Repo, draft: DraftDoc): Repo {
  return {
    find: (id: AnyDocumentId) => {
      const clone = draft.clones?.[id as AutomergeUrl]?.cloneUrl;
      return base.find(clone ?? id);
    },
  } as unknown as Repo;
}
