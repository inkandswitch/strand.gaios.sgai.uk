import { beforeAll, describe, expect, it } from "vitest";
import {
  Repo,
  initSubduction,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { request, subscribe } from "@inkandswitch/patchwork-providers";

import { OverlayProvider } from "./providers/OverlayProvider.js";
import type { OverlayRepo } from "./overlay-repo.js";
import type {
  DraftDoc,
  Member,
  MergeConflicts,
  MergeDoc,
  OverlaysState,
  Workspace,
} from "./overlay-types.js";

type Note = { "@patchwork": { type: "note" }; text: string };
type Folder = { "@patchwork": { type: "folder" }; docs: AutomergeUrl[] };

beforeAll(() => {
  initSubduction();
  getRegistry("patchwork:children").register(
    {
      type: "patchwork:children",
      id: "test-folder-children",
      name: "Folder children",
      datatypes: ["folder"],
      load: async () => (doc: Folder) => doc.docs,
    } as never,
    "test"
  );
  getRegistry("patchwork:merge-conflicts").register(
    {
      type: "patchwork:merge-conflicts",
      id: "test-note-conflicts",
      name: "Note conflicts",
      datatypes: ["note"],
      // A rating both sides set differently.
      load: async () => ({ source, target }: { source: any; target: any }) =>
        source.rating !== undefined && target.rating !== undefined && source.rating !== target.rating
          ? [{ at: { path: ["rating"] }, source: source.rating, target: target.rating }]
          : [],
    } as never,
    "test"
  );
});

// A folder holding one note, with an overlay provider mounted on it.
function project() {
  const repo = new Repo();
  const note = repo.create<Note>({ "@patchwork": { type: "note" }, text: "main" });
  const root = repo.create<Folder>({ "@patchwork": { type: "folder" }, docs: [note.url] });
  const provider: HTMLElement & { repo?: Repo } = document.createElement("div");
  provider.setAttribute("doc-url", root.url);
  const child = document.createElement("div");
  provider.append(child);
  const dispose = OverlayProvider(provider, repo);
  const overlays = watch<OverlaysState>(child, { type: "overlays" });
  const send = <T>(selector: Record<string, unknown>) =>
    request(child, selector as never) as Promise<T>;
  const overlayRepo = () => provider.repo as unknown as OverlayRepo;
  const onCheckout = async () => overlayRepo().find<Note>(note.url);
  // `url` as `overlay` has it, read the way a view reads the other side: the
  // provider says where it lives, and that's opened on the base repo.
  const versionIn = async <T>(overlay: AutomergeUrl | null, url: AutomergeUrl) => {
    const where = await send<{ url: AutomergeUrl; cloneUrl?: AutomergeUrl }>({
      type: "repo:handle-descriptor",
      url,
      overlay,
    });
    return repo.find<T>(where.cloneUrl ?? where.url);
  };
  return { repo, note, root, child, overlayRepo, overlays, send, onCheckout, versionIn, dispose };
}

// The latest answer to `selector`, and a way to wait for one that fits.
function watch<T>(element: HTMLElement, selector: Record<string, unknown>) {
  let latest: T | undefined;
  const waiters: (() => void)[] = [];
  const stop = subscribe(element, selector as never, (value) => {
    latest = value as T;
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (ready: (value: T) => boolean) => {
    while (latest === undefined || !ready(latest)) {
      await new Promise<void>((wake) => waiters.push(wake));
    }
    return latest;
  };
  return { until, stop, latest: () => latest };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

async function edit(handle: DocHandle<Note>, text: string) {
  handle.change((d) => {
    d.text = text;
  });
  await settle();
}

describe("the overlay provider", () => {
  it("starts on main, with no overlays", async () => {
    const { overlays, dispose } = project();
    expect(await overlays.until((s) => s.status === "ready")).toEqual({
      checkedOut: null,
      at: null,
      status: "ready",
      drafts: [],
      merges: [],
    });
    dispose();
  });

  it("forks drafts off main and off drafts, checking each out", async () => {
    const { overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const first = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const second = await send<AutomergeUrl>({ type: "draft:create", parent: first });
    const state = await overlays.until((s) => s.drafts.length === 2 && s.checkedOut === second);
    expect(state.drafts).toEqual([
      { url: first, name: "Draft", parent: null },
      { url: second, name: "Draft", parent: first },
    ]);
    expect(await send({ type: "draft:rename", draft: first, name: " Mine " })).toBe(true);
    await overlays.until((s) => s.drafts[0].name === "Mine");
    dispose();
  });

  it("keeps a draft's edits in the draft", async () => {
    const { repo, note, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const onDraft = await onCheckout();
    await edit(onDraft, "draft");

    expect(onDraft.url).toBe(note.url);
    expect(onDraft.doc().text).toBe("draft");
    expect(note.doc().text).toBe("main");
    expect((await repo.find<DraftDoc>(draft)).doc().clones[note.url].cloneUrl).toBeDefined();

    await send({ type: "overlay:checkout", overlay: null });
    await settle();
    expect(onDraft.doc().text).toBe("main");
    dispose();
  });

  it("reads another overlay's version, whatever is checked out", async () => {
    const { note, overlayRepo, overlays, send, onCheckout, versionIn, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await edit(await onCheckout(), "draft");
    await send({ type: "overlay:checkout", overlay: null });

    const inDraft = await versionIn<Note>(draft, note.url);
    const onMain = await overlayRepo().find<Note>(note.url);
    expect(inDraft.doc().text).toBe("draft");
    expect(onMain.doc().text).toBe("main");
    dispose();
  });

  it("tells each overlay's members by their heads", async () => {
    const { root, note, child, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const onMain = watch<Member[]>(child, { type: "overlay:members", overlay: null });
    const onDraft = watch<Member[]>(child, { type: "overlay:members", overlay: draft });
    const heads = (members: Member[], url: AutomergeUrl) =>
      members.find((member) => member.url === url)?.heads;

    const before = await onDraft.until((m) => m.length === 2);
    expect(before.map((m) => [m.url, m.parent])).toEqual([
      [root.url, null],
      [note.url, root.url],
    ]);
    const main = await onMain.until((m) => m.length === 2);
    expect(heads(before, note.url)).toEqual(heads(main, note.url));

    await edit(await onCheckout(), "draft");
    const after = await onDraft.until((m) => heads(m, note.url)?.join() !== heads(main, note.url)?.join());
    expect(heads(after, root.url)).toEqual(heads(main, root.url));
    dispose();
  });

  it("merges in memory, writing nothing until the merge is edited", async () => {
    const { repo, note, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await edit(await onCheckout(), "draft");

    const merge = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    const state = await overlays.until((s) => s.checkedOut === merge);
    expect(state.merges).toEqual([{ url: merge, source: draft, target: null, published: false }]);

    const merged = await onCheckout();
    expect(merged.doc().text).toBe("draft");
    expect((await repo.find<MergeDoc>(merge)).doc().clones).toEqual({});
    expect(note.doc().text).toBe("main");

    // Edited, it's the merge's own, and still follows its inputs.
    await edit(merged, "fixed");
    expect((await repo.find<MergeDoc>(merge)).doc().clones[note.url].cloneUrl).toBeDefined();
    expect(note.doc().text).toBe("main");
    note.change((d) => {
      d.text = "main again";
    });
    await settle();
    expect(merged.doc().text).toBe("fixed");
    dispose();
  });

  it("follows the source while the merge is looked over", async () => {
    const { overlays, overlayRepo, note, send, onCheckout, versionIn, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const onDraft = await onCheckout();
    await edit(onDraft, "draft");
    const merge = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await overlays.until((s) => s.checkedOut === merge);
    const merged = await overlayRepo().find<Note>(note.url);

    const inDraft = await versionIn<Note>(draft, note.url);
    await edit(inDraft, "draft, later");
    expect(merged.doc().text).toBe("draft, later");
    dispose();
  });

  it("accepts a merge into its target, taking the source off the list", async () => {
    const { note, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await edit(await onCheckout(), "draft");
    const merge = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await overlays.until((s) => s.checkedOut === merge);

    expect(await send({ type: "merge:accept", merge })).toBe(true);
    const state = await overlays.until((s) => s.drafts.length === 0);
    expect(state).toMatchObject({ checkedOut: null, merges: [] });
    expect(note.doc().text).toBe("draft");
    dispose();
  });

  it("merges main into a draft, leaving main alone", async () => {
    const { note, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await settle();
    note.change((d) => {
      d.text = "main, later";
    });
    const merge = await send<AutomergeUrl>({ type: "merge:create", source: null, target: draft });
    await overlays.until((s) => s.checkedOut === merge);
    expect(await send({ type: "merge:accept", merge })).toBe(true);
    const state = await overlays.until((s) => s.merges.length === 0 && s.checkedOut === draft);
    expect(state.drafts.map((entry) => entry.url)).toEqual([draft]);
    expect((await onCheckout()).doc().text).toBe("main, later");
    dispose();
  });

  it("deletes a draft with its merges, checking main out", async () => {
    const { overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await send({ type: "merge:create", source: draft, target: null });
    await send({ type: "overlay:checkout", overlay: draft });
    expect(await send({ type: "overlay:delete", overlay: draft })).toBe(true);
    expect(await overlays.until((s) => s.drafts.length === 0)).toMatchObject({
      checkedOut: null,
      merges: [],
    });
    dispose();
  });

  it("starts a merge as a preview nobody else sees, and publishes it as a pull request", async () => {
    const { repo, root, overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const preview = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await overlays.until((s) => s.checkedOut === preview);
    const workspace = async () => {
      const url = (await repo.find<any>(root.url)).doc()["@patchwork"].workspaceUrl;
      return (await repo.find<Workspace>(url)).doc();
    };
    expect((await workspace()).merges).toEqual([]);

    // Each one is a new preview, until one is published.
    const another = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    expect(another).not.toBe(preview);

    expect(await send({ type: "overlay:checkout", overlay: preview })).toBe(true);
    expect(await send({ type: "merge:publish", merge: preview })).toBe(true);
    expect((await workspace()).merges).toEqual([preview]);
    const state = await overlays.until((s) => s.merges.some((m) => m.url === preview && m.published));
    expect(state.merges).toEqual([{ url: preview, source: draft, target: null, published: true }]);
    expect(await send({ type: "merge:create", source: draft, target: null })).toBe(preview);
    dispose();
  });

  it("cancels a preview, checking its source out again", async () => {
    const { overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const preview = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await overlays.until((s) => s.checkedOut === preview);
    expect(await send({ type: "overlay:delete", overlay: preview })).toBe(true);
    const state = await overlays.until((s) => s.checkedOut === draft);
    expect(state.merges).toEqual([]);
    expect(state.drafts.map((entry) => entry.url)).toEqual([draft]);
    dispose();
  });

  it("checks a preview out by its url, as a link would", async () => {
    const { overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const preview = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await send({ type: "overlay:checkout", overlay: null });
    await overlays.until((s) => s.checkedOut === null && s.merges.length === 0);
    expect(await send({ type: "overlay:checkout", overlay: preview })).toBe(true);
    const state = await overlays.until((s) => s.checkedOut === preview);
    expect(state.merges).toEqual([{ url: preview, source: draft, target: null, published: false }]);
    dispose();
  });

  it("tells a merge's conflicts, and won't accept it while any is open", async () => {
    const { note, overlays, send, onCheckout, child, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    (await onCheckout()).change((d: any) => {
      d.rating = 2;
    });
    note.change((d: any) => {
      d.rating = 3;
    });
    const merge = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await overlays.until((s) => s.checkedOut === merge);

    const conflicts = watch<MergeConflicts>(child, { type: "merge:conflicts", merge });
    const open = await conflicts.until((c) => (c[note.url]?.length ?? 0) > 0);
    expect(open[note.url]).toEqual([{ at: { path: ["rating"] }, source: 2, target: 3, state: "open" }]);
    expect(await send({ type: "merge:accept", merge })).toBeNull();

    (await onCheckout()).change((d: any) => {
      d.rating = 2;
    });
    const taken = await conflicts.until((c) => c[note.url]?.[0]?.state !== "open");
    expect(taken[note.url][0].state).toBe("source");
    expect(await send({ type: "merge:accept", merge })).toBe(true);
    await overlays.until((s) => s.checkedOut === null);
    expect((note.doc() as any).rating).toBe(2);
    conflicts.stop();
    dispose();
  });

  it("refuses what it can't do", async () => {
    const { overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    expect(await send({ type: "merge:create", source: null, target: null })).toBeNull();
    expect(await send({ type: "overlay:checkout", overlay: "automerge:nope" })).toBeNull();
    dispose();
  });
});
