import { beforeAll, describe, expect, it } from "vitest";
import * as Automerge from "@automerge/automerge/slim";
import {
  Repo,
  initSubduction,
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";

import { forkDraft, mergeInto, renameDraft } from "../draft-actions.js";
import type { DraftDoc, HasDrafts } from "../draft-types.js";
import { readFiles, writableHandle, type Line } from "./files.js";
import { MemoryRemote } from "./memory-remote.js";
import {
  connect,
  mainDraft,
  noteMerge,
  openBranch,
  openableBranches,
  publishDraft,
  status,
  sync,
  syncPoints,
  type GitContext,
} from "./sync.js";

type Folder = HasDrafts & {
  title: string;
  docs: { url: AutomergeUrl; type: string; name: string }[];
};

beforeAll(() => {
  initSubduction();
  getRegistry("patchwork:children").register(
    {
      type: "patchwork:children",
      id: "git-test-folder-children",
      name: "Folder children",
      datatypes: ["folder"],
      load: async () => (doc: Folder) => (doc.docs ?? []).map(({ url, type }) => ({ url, type })),
    } as never,
    "test",
  );
});

const CONFIG = { owner: "o", repo: "r", branch: "main" };

// A workspace of text files, and a repo whose main has `onGit`.
async function setup(
  files: Record<string, string>,
  onGit: Record<string, string> = { "README.md": "hello\n" },
) {
  const repo = new Repo();
  const remote = new MemoryRemote();
  await remote.push("main", onGit, "first");
  const docs = Object.entries(files).map(([name, content]) => {
    const file = repo.create({
      "@patchwork": { type: "file" },
      name,
      extension: "",
      mimeType: "text/plain",
      content,
    });
    return { url: file.url, type: "file", name };
  });
  const root = repo.create<Folder>({
    "@patchwork": { type: "folder" },
    title: "ws",
    docs,
  });
  const ctx: GitContext = {
    repo,
    root: root as unknown as DocHandle<HasDrafts>,
    remote,
  };
  return { repo, remote, root, ctx };
}

function mainLine(ctx: GitContext): Line {
  return { repo: ctx.repo, root: ctx.root.url, draft: null };
}

async function draftLine(ctx: GitContext, url: AutomergeUrl): Promise<Line> {
  return {
    repo: ctx.repo,
    root: ctx.root.url,
    draft: await ctx.repo.find<DraftDoc>(url),
  };
}

async function files(line: Line): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [path, file] of (await readFiles(line)).files) {
    if (file.kind === "json") out[path] = JSON.stringify(file.value);
    else
      out[path] =
        typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
  }
  return out;
}

async function edit(line: Line, path: string, text: string) {
  const file = (await readFiles(line)).files.get(path)!;
  const handle = await writableHandle(line, file.doc);
  handle.change((d: unknown) =>
    Automerge.updateText(d as Automerge.Doc<unknown>, ["content"], text),
  );
}

async function tipFiles(remote: MemoryRemote, branch = "main") {
  return remote.files((await remote.tip(branch))!);
}

describe("connecting main", () => {
  it("brings in the repo's files and commits the workspace's", async () => {
    const { ctx, remote } = await setup({ "a.txt": "one\n" });
    await connect(ctx, CONFIG, "Connect");

    expect(await files(mainLine(ctx))).toEqual({
      "a.txt": "one\n",
      "README.md": "hello\n",
    });
    expect(await tipFiles(remote)).toEqual({
      "a.txt": "one\n",
      "README.md": "hello\n",
    });
    const state = await status(ctx, null);
    expect(state).toMatchObject({ kind: "linked", local: [], incoming: [] });
  });
});

describe("syncing main", () => {
  async function connected() {
    const env = await setup({ "a.txt": "one\ntwo\nthree\n" });
    await connect(env.ctx, CONFIG, "Connect");
    return env;
  }

  it("exports edits made here as one commit", async () => {
    const { ctx, remote } = await connected();
    await edit(mainLine(ctx), "a.txt", "one\nTWO\nthree\n");
    expect(await status(ctx, null)).toMatchObject({ local: ["a.txt"] });

    const result = await sync(ctx, null, "Shout two");
    expect(result.exported).toEqual(["a.txt"]);
    expect((await tipFiles(remote))["a.txt"]).toBe("one\nTWO\nthree\n");
    expect(remote.message((await remote.tip("main"))!)).toBe("Shout two");
    expect(await status(ctx, null)).toMatchObject({ local: [], incoming: [] });
  });

  it("exports files added in folders and files deleted here", async () => {
    const { ctx, remote, repo, root } = await connected();
    const file = repo.create({
      "@patchwork": { type: "file" },
      name: "n.txt",
      extension: "txt",
      mimeType: "text/plain",
      content: "new\n",
    });
    const sub = repo.create({
      "@patchwork": { type: "folder" },
      title: "sub",
      docs: [{ name: "n.txt", type: "file", url: file.url }],
    });
    root.change((d) => {
      d.docs.push({ name: "sub", type: "folder", url: sub.url });
      d.docs.splice(
        d.docs.findIndex((link) => link.name === "README.md"),
        1,
      );
    });

    expect((await sync(ctx, null, "")).exported.sort()).toEqual(["README.md", "sub/n.txt"]);
    expect(await tipFiles(remote)).toEqual({
      "a.txt": "one\ntwo\nthree\n",
      "sub/n.txt": "new\n",
    });
  });

  it("imports commits made in git", async () => {
    const { ctx, remote } = await connected();
    await remote.push("main", {
      "a.txt": "one\ntwo\nthree\nfour\n",
      "dir/b.txt": "bee\n",
      "README.md": null,
    });
    expect(await status(ctx, null)).toMatchObject({
      incoming: [{ message: "edit" }],
    });

    const result = await sync(ctx, null, "");
    expect(result.imported.sort()).toEqual(["README.md", "a.txt", "dir/b.txt"]);
    expect(result.exported).toEqual([]);
    expect(await files(mainLine(ctx))).toEqual({
      "a.txt": "one\ntwo\nthree\nfour\n",
      "dir/b.txt": "bee\n",
    });
    expect(await status(ctx, null)).toMatchObject({ local: [], incoming: [] });
  });

  it("merges when both sides moved, and exports the merge", async () => {
    const { ctx, remote } = await connected();
    await edit(mainLine(ctx), "a.txt", "ONE\ntwo\nthree\n");
    await remote.push("main", { "a.txt": "one\ntwo\nTHREE\n" });

    await sync(ctx, null, "Both");
    expect((await files(mainLine(ctx)))["a.txt"]).toBe("ONE\ntwo\nTHREE\n");
    expect((await tipFiles(remote))["a.txt"]).toBe("ONE\ntwo\nTHREE\n");
  });

  it("adopts a commit that already matches instead of importing it again", async () => {
    const { ctx, remote } = await connected();
    await edit(mainLine(ctx), "a.txt", "one\ntwo\nthree\nfour\n");
    // as if this side pushed, and the record of it was lost
    await remote.push("main", { "a.txt": "one\ntwo\nthree\nfour\n" });

    const result = await sync(ctx, null, "");
    expect(result.imported).toEqual([]);
    expect((await files(mainLine(ctx)))["a.txt"]).toBe("one\ntwo\nthree\nfour\n");
  });

  it("refuses a branch that was rewritten", async () => {
    const { ctx, remote } = await connected();
    const first = remote.parents((await remote.tip("main"))!)[0];
    remote.refs.set("main", first);
    await remote.push("main", { "x.txt": "x" });
    await expect(sync(ctx, null, "")).rejects.toThrow(/rewritten/);
  });
});

describe("drafts and branches", () => {
  async function connected() {
    const env = await setup({ "a.txt": "one\ntwo\nthree\n" });
    await connect(env.ctx, CONFIG, "Connect");
    return env;
  }

  async function newDraft(ctx: GitContext, name: string) {
    const url = await forkDraft(ctx.repo, ctx.root, null);
    await renameDraft(ctx.repo, ctx.root, url, name);
    return url;
  }

  it("puts a draft on a branch of its name, and syncs it", async () => {
    const { ctx, remote } = await connected();
    const url = await newDraft(ctx, "feature");
    const line = await draftLine(ctx, url);
    await edit(line, "a.txt", "one\nTWO\nthree\n");

    await publishDraft(ctx, line.draft!, "Start feature");
    expect((await tipFiles(remote, "feature"))["a.txt"]).toBe("one\nTWO\nthree\n");
    expect((await tipFiles(remote, "main"))["a.txt"]).toBe("one\ntwo\nthree\n");
    expect(await files(mainLine(ctx))).toMatchObject({
      "a.txt": "one\ntwo\nthree\n",
    });

    await remote.push("feature", { "c.txt": "see\n" });
    await edit(line, "a.txt", "one\nTWO\nthree\nfour\n");
    await sync(ctx, line.draft, "More");
    expect(await files(line)).toMatchObject({
      "a.txt": "one\nTWO\nthree\nfour\n",
      "c.txt": "see\n",
    });
    expect(await tipFiles(remote, "feature")).toMatchObject({
      "a.txt": "one\nTWO\nthree\nfour\n",
      "c.txt": "see\n",
    });
    expect(await files(mainLine(ctx))).not.toHaveProperty("c.txt");
  });

  it("won't put a draft on a branch when its name can't be one", async () => {
    const { ctx } = await connected();
    const url = await newDraft(ctx, "my feature");
    const draft = await ctx.repo.find<DraftDoc>(url);
    expect(await status(ctx, draft)).toMatchObject({
      kind: "unlinked",
      problem: expect.stringMatching(/branch name/),
    });
    await expect(publishDraft(ctx, draft, "")).rejects.toThrow(/branch name/);
  });

  it("won't put a draft on a branch when it was copied before main was synced", async () => {
    const { ctx } = await setup({ "a.txt": "one\n" });
    const url = await newDraft(ctx, "early");
    await connect(ctx, CONFIG, "Connect");
    const draft = await ctx.repo.find<DraftDoc>(url);
    expect(await status(ctx, draft)).toMatchObject({
      kind: "unlinked",
      problem: expect.stringMatching(/before main was synced/),
    });
  });

  it("puts a draft on a branch when main had unsynced changes it was copied with", async () => {
    const { ctx, remote } = await connected();
    await edit(mainLine(ctx), "a.txt", "one\ntwo\nthree\nmain\n");
    const url = await newDraft(ctx, "later");
    const draft = await ctx.repo.find<DraftDoc>(url);
    await publishDraft(ctx, draft, "");
    expect((await tipFiles(remote, "later"))["a.txt"]).toBe("one\ntwo\nthree\nmain\n");
  });

  it("opens a branch made in git as a draft", async () => {
    const { ctx, remote } = await connected();
    remote.refs.set("topic", (await remote.tip("main"))!);
    await remote.push("topic", {
      "a.txt": "one\ntwo\nthree\ntopic\n",
      "t.txt": "tee\n",
    });
    expect(await openableBranches(ctx)).toEqual(["topic"]);

    const url = await openBranch(ctx, "topic");
    const line = await draftLine(ctx, url);
    expect(await files(line)).toMatchObject({
      "a.txt": "one\ntwo\nthree\ntopic\n",
      "t.txt": "tee\n",
    });
    expect(await files(mainLine(ctx))).toEqual({
      "a.txt": "one\ntwo\nthree\n",
      "README.md": "hello\n",
    });
    expect(await status(ctx, line.draft)).toMatchObject({
      kind: "linked",
      local: [],
      incoming: [],
    });
    expect(await openableBranches(ctx)).toEqual([]);
  });

  it("makes a merge commit when a linked draft is merged here", async () => {
    const { ctx, remote } = await connected();
    const url = await newDraft(ctx, "feature");
    const line = await draftLine(ctx, url);
    await edit(line, "a.txt", "one\nTWO\nthree\n");
    await publishDraft(ctx, line.draft!, "Feature");
    const featureTip = (await remote.tip("feature"))!;

    await noteMerge(ctx, line.draft!, null);
    await mergeInto(ctx.repo, ctx.root, url, null);
    await sync(ctx, null, "Merge feature");

    const tip = (await remote.tip("main"))!;
    expect(remote.parents(tip)).toContain(featureTip);
    expect((await tipFiles(remote))["a.txt"]).toBe("one\nTWO\nthree\n");
  });

  it("merges a draft here when its branch was merged in git, without doubling it", async () => {
    const { ctx, remote } = await connected();
    const url = await newDraft(ctx, "feature");
    const line = await draftLine(ctx, url);
    await edit(line, "a.txt", "one\nTWO\nthree\n");
    await publishDraft(ctx, line.draft!, "Feature");
    await remote.merge("main", "feature");

    const result = await sync(ctx, null, "");
    expect(result.merged).toEqual([url]);
    expect((await files(mainLine(ctx)))["a.txt"]).toBe("one\nTWO\nthree\n");
    expect((await ctx.repo.find<DraftDoc>(url)).doc().mergedAt).toBeDefined();
    expect(await status(ctx, null)).toMatchObject({ local: [], incoming: [] });
  });

  it("records each sync on the line it belongs to", async () => {
    const { ctx } = await connected();
    const main = await mainDraft(ctx);
    expect(syncPoints(main)).toHaveLength(1);
  });
});

describe(".pushworkattributes, as pushwork reads it", () => {
  const RULES =
    "*.nb  datatype=notebook  import=automerge:2a5Rkw9LkqXfBAQZbcBWjTcf15Mc  strip-metadata\n";
  // a notebook laid out with one-space indents, as Jupyter writes them
  const notebook = (cells: string[]) => JSON.stringify({ cells, nbformat: 4 }, null, 1) + "\n";

  async function docAt(ctx: GitContext, line: Line, path: string) {
    const file = (await readFiles(line)).files.get(path)!;
    const url = file.doc;
    const entry = line.draft?.doc()?.clones?.[url];
    return { file, doc: (await ctx.repo.find<any>(entry?.cloneUrl ?? url)).doc() };
  }

  async function linkOf(ctx: GitContext, name: string) {
    const root = (ctx.root as unknown as DocHandle<Folder>).doc();
    return root.docs.find((link) => link.name === name)!;
  }

  it("brings a file a datatype rule covers in as a JSON document of that type", async () => {
    const { ctx } = await setup({}, { ".pushworkattributes": RULES, "a.nb": notebook(["one"]) });
    await connect(ctx, CONFIG, "Connect");

    const { file, doc } = await docAt(ctx, mainLine(ctx), "a.nb");
    expect(file.kind).toBe("json");
    expect(doc.cells).toEqual(["one"]);
    expect(doc["@patchwork"]).toEqual({
      type: "notebook",
      suggestedImportUrl: "automerge:2a5Rkw9LkqXfBAQZbcBWjTcf15Mc",
    });
    expect((await linkOf(ctx, "a.nb")).type).toBe("notebook");
    expect(await status(ctx, null)).toMatchObject({ local: [], incoming: [] });
  });

  it("writes a JSON document back without its metadata, laid out like git's file", async () => {
    const { ctx, remote } = await setup(
      {},
      { ".pushworkattributes": RULES, "a.nb": notebook(["one"]) },
    );
    await connect(ctx, CONFIG, "Connect");
    const { file } = await docAt(ctx, mainLine(ctx), "a.nb");
    (await writableHandle(mainLine(ctx), file.doc)).change((d: any) => {
      d.cells.push("two");
    });

    expect(await status(ctx, null)).toMatchObject({ local: ["a.nb"] });
    await sync(ctx, null, "");
    expect((await tipFiles(remote))["a.nb"]).toBe(notebook(["one", "two"]));
  });

  it("merges a notebook edited in git and here, key by key", async () => {
    const { ctx, remote } = await setup(
      {},
      { ".pushworkattributes": RULES, "a.nb": notebook(["one", "two"]) },
    );
    await connect(ctx, CONFIG, "Connect");
    const { file } = await docAt(ctx, mainLine(ctx), "a.nb");
    (await writableHandle(mainLine(ctx), file.doc)).change((d: any) => {
      d.cells[0] = "ONE";
    });
    await remote.push("main", { "a.nb": notebook(["one", "two", "three"]) });

    await sync(ctx, null, "");
    const { doc } = await docAt(ctx, mainLine(ctx), "a.nb");
    expect(doc.cells).toEqual(["ONE", "two", "three"]);
    expect(doc["@patchwork"].type).toBe("notebook");
    expect((await tipFiles(remote))["a.nb"]).toBe(notebook(["ONE", "two", "three"]));
  });

  it("writes a JSON document no rule covers with its metadata, as pushwork does", async () => {
    const { ctx, remote, repo, root } = await setup({ "a.txt": "a\n" });
    const board = repo.create({ "@patchwork": { type: "tldraw" }, shapes: [] });
    root.change((d) => {
      d.docs.push({ name: "board.tldraw", type: "tldraw", url: board.url });
    });
    await connect(ctx, CONFIG, "Connect");

    expect(JSON.parse((await tipFiles(remote))["board.tldraw"])).toEqual({
      "@patchwork": { type: "tldraw" },
      shapes: [],
    });
    expect(await status(ctx, null)).toMatchObject({ local: [], incoming: [] });
  });

  it("turns a file into a JSON document when a rule comes to cover it", async () => {
    const { ctx, remote } = await setup({}, { "a.nb": notebook(["one"]) });
    await connect(ctx, CONFIG, "Connect");
    expect((await docAt(ctx, mainLine(ctx), "a.nb")).file.kind).toBe("text");

    await remote.push("main", { ".pushworkattributes": RULES });
    await sync(ctx, null, "");
    const { file, doc } = await docAt(ctx, mainLine(ctx), "a.nb");
    expect(file.kind).toBe("json");
    expect(doc.cells).toEqual(["one"]);
    expect(await status(ctx, null)).toMatchObject({ local: [], incoming: [] });
  });

  it("stores an artifact's text whole, linked pinned to its version", async () => {
    const { ctx, remote } = await setup({}, { "dist/app.js": "v1\n" });
    await connect(ctx, CONFIG, "Connect");
    const before = await docAt(ctx, mainLine(ctx), "dist/app.js");
    expect(before.file.kind).toBe("immutable");

    await remote.push("main", { "dist/app.js": "v2\n" });
    await sync(ctx, null, "");
    const after = await docAt(ctx, mainLine(ctx), "dist/app.js");
    expect(after.file.kind === "immutable" && after.file.content).toBe("v2\n");
    const dist = (await readFiles(mainLine(ctx))).folders.get("dist")!;
    const link = (await ctx.repo.find<Folder>(dist)).doc().docs[0];
    expect(parseAutomergeUrl(link.url).heads).toEqual(
      (await ctx.repo.find(after.file.doc)).heads(),
    );
  });

  it("never deletes the file of a doc it can't read", async () => {
    const { ctx, remote, root } = await setup({ "a.txt": "a\n" }, { "lost.txt": "keep me\n" });
    await connect(ctx, CONFIG, "Connect");
    // the doc lost.txt links to is gone from here
    root.change((d) => {
      const link = d.docs.find((l) => l.name === "lost.txt")!;
      link.url = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl;
    });
    await edit(mainLine(ctx), "a.txt", "A\n");

    await sync(ctx, null, "");
    expect(await tipFiles(remote)).toMatchObject({ "a.txt": "A\n", "lost.txt": "keep me\n" });
  }, 30_000);
});
