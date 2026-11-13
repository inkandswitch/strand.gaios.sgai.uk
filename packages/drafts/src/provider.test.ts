import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AutomergeUrl,
} from "@automerge/automerge-repo";
import { request, subscribe } from "@inkandswitch/patchwork-providers";

import { DraftProvider } from "./providers/DraftProvider.js";
import type { DraftDoc, DraftsState, HasDrafts } from "./draft-types.js";

beforeAll(() => initSubduction());

function workspace(repo = new Repo(), docs: AutomergeUrl[] = []) {
  const root = repo.create<HasDrafts & { docs: unknown[] }>({
    "@patchwork": { type: "folder" },
    docs: docs.map((url, i) => ({ name: `doc ${i}`, type: "note", url })),
  });
  const provider: HTMLElement & { repo?: Repo } = document.createElement("div");
  provider.setAttribute("doc-url", root.url);
  const child = document.createElement("div");
  provider.append(child);
  const dispose = DraftProvider(provider, repo);
  return { root, child, provider, dispose };
}

// The latest state, once `ready` says it has caught up.
function watch(element: HTMLElement) {
  let latest: DraftsState | undefined;
  const waiters: (() => void)[] = [];
  const stop = subscribe<DraftsState>(element, { type: "drafts" }, (state) => {
    latest = state;
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (ready: (state: DraftsState) => boolean) => {
    while (!latest || !ready(latest)) {
      await new Promise<void>((wake) => waiters.push(wake));
    }
    return latest;
  };
  return { until, stop, latest: () => latest };
}

describe("the draft provider", () => {
  it("starts on main, named by the workspace's url", async () => {
    const { root, child, dispose } = workspace();
    const drafts = watch(child);
    const state = await drafts.until((s) => s.status === "ready");
    expect(state).toEqual({
      workspace: root.url,
      main: root.url,
      checkedOut: root.url,
      status: "ready",
      drafts: [{ url: root.url, name: "Main", parent: null, depth: 0 }],
    });
    drafts.stop();
    dispose();
  });

  it("creates drafts off main and off drafts, checking each out", async () => {
    const { child, dispose } = workspace();
    const drafts = watch(child);
    const { main } = await drafts.until((s) => s.status === "ready");

    const first = await request<{ draft: AutomergeUrl }>(child, {
      type: "draft:create",
      from: main,
    });
    const second = await request<{ draft: AutomergeUrl }>(child, {
      type: "draft:create",
      from: first.draft,
    });
    const state = await drafts.until((s) => s.drafts.length === 3);

    expect(state.checkedOut).toBe(second.draft);
    expect(state.main).not.toBe(state.workspace);
    expect(state.drafts).toEqual([
      { url: state.main, name: "Main", parent: null, depth: 0 },
      { url: first.draft, name: "Draft 1", parent: state.main, depth: 1 },
      { url: second.draft, name: "Draft 2", parent: first.draft, depth: 2 },
    ]);
    drafts.stop();
    dispose();
  });

  it("checks main out by its url or the workspace's", async () => {
    const { root, child, dispose } = workspace();
    const drafts = watch(child);
    const { main } = await drafts.until((s) => s.status === "ready");
    const { draft } = await request<{ draft: AutomergeUrl }>(child, {
      type: "draft:create",
      from: main,
    });
    const state = await drafts.until((s) => s.checkedOut === draft);

    const back = await request<{ draft: AutomergeUrl }>(child, {
      type: "draft:checkout",
      draft: root.url,
    });
    expect(back.draft).toBe(state.main);
    await drafts.until((s) => s.checkedOut === state.main);
    drafts.stop();
    dispose();
  });

  it("merges a draft into its parent and checks the parent out", async () => {
    const { child, dispose } = workspace();
    const drafts = watch(child);
    const { main } = await drafts.until((s) => s.status === "ready");
    const { draft } = await request<{ draft: AutomergeUrl }>(child, {
      type: "draft:create",
      from: main,
    });
    const { main: mainDraft } = await drafts.until((s) => s.checkedOut === draft);

    const { into } = await request<{ into: AutomergeUrl }>(child, {
      type: "draft:merge",
      draft,
    });
    expect(into).toBe(mainDraft);
    const state = await drafts.until((s) => s.drafts.length === 1);
    expect(state.checkedOut).toBe(mainDraft);
    drafts.stop();
    dispose();
  });

  it("merges a draft into a sibling, handing it the draft's children", async () => {
    const { child, dispose } = workspace();
    const drafts = watch(child);
    const { main } = await drafts.until((s) => s.status === "ready");
    const create = (from: AutomergeUrl) =>
      request<{ draft: AutomergeUrl }>(child, { type: "draft:create", from });
    const { draft: sibling } = await create(main);
    const { draft } = await create(main);
    const { draft: grandchild } = await create(draft);
    await drafts.until((s) => s.drafts.length === 4);

    const refused = await Promise.race([
      request(child, { type: "draft:merge", draft, into: grandchild }),
      new Promise((wake) => setTimeout(() => wake("unanswered"), 50)),
    ]);
    expect(refused).toBe("unanswered");

    await request(child, { type: "draft:checkout", draft });
    const { into } = await request<{ into: AutomergeUrl }>(child, {
      type: "draft:merge",
      draft,
      into: sibling,
    });
    expect(into).toBe(sibling);
    const state = await drafts.until((s) => s.drafts.length === 3 && s.checkedOut === sibling);
    expect(state.drafts.find((entry) => entry.url === grandchild)?.parent).toBe(sibling);
    drafts.stop();
    dispose();
  });

  it("previews a merge in a hidden draft, writing nothing else", async () => {
    const repo = new Repo();
    const note = repo.create<{ text: string }>({ text: "main" });
    const { child, provider, dispose } = workspace(repo, [note.url]);
    const drafts = watch(child);
    const { main } = await drafts.until((s) => s.status === "ready");
    const { draft } = await request<{ draft: AutomergeUrl }>(child, {
      type: "draft:create",
      from: main,
    });
    const { main: mainDraft } = await drafts.until((s) => s.checkedOut === draft);
    const edited = await provider.repo!.find<{ text: string }>(note.url);
    edited.change((d) => {
      d.text = "draft";
    });

    const { preview } = await request<{ preview: AutomergeUrl }>(child, {
      type: "draft:preview-merge",
      draft,
      into: mainDraft,
    });
    const previewDoc = (await repo.find<DraftDoc>(preview)).doc();
    const copy = previewDoc.clones[note.url]?.cloneUrl;
    expect(copy).toBeDefined();
    expect((await repo.find<{ text: string }>(copy!)).doc().text).toBe("draft");
    expect(note.doc().text).toBe("main");
    expect(drafts.latest()?.drafts.map((entry) => entry.url)).toEqual([mainDraft, draft]);

    await request(child, { type: "draft:discard", draft: preview });
    const parent = (await repo.find<DraftDoc>(mainDraft)).doc();
    expect(parent.drafts).toEqual([draft]);
    drafts.stop();
    dispose();
  });

  it("renames drafts, main included", async () => {
    const { child, dispose } = workspace();
    const drafts = watch(child);
    const { main } = await drafts.until((s) => s.status === "ready");

    const { name } = await request<{ name: string }>(child, {
      type: "draft:rename",
      draft: main,
      name: "Published",
    });
    expect(name).toBe("Published");
    await drafts.until((s) => s.drafts[0].name === "Published");
    drafts.stop();
    dispose();
  });
});
