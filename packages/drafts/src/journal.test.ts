import { beforeAll, describe, expect, it } from "vitest";
import * as Automerge from "@automerge/automerge";
import { Repo, initSubduction, type AutomergeUrl, type DocHandle } from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { request, subscribe } from "@inkandswitch/patchwork-providers";

import { OverlayProvider } from "./providers/OverlayProvider.js";
import type { OverlayRepo } from "./overlay-repo.js";
import type {
  DraftDoc,
  HistoryEntry,
  HistoryGroupsDoc,
  JournalDoc,
  JournalMessage,
  OverlaysState,
  Workspace,
} from "./overlay-types.js";

type Note = { "@patchwork": { type: "note" }; text: string };
type Folder = { "@patchwork": { type: "folder"; workspaceUrl?: AutomergeUrl }; docs: AutomergeUrl[] };

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
});

// A document as if it were loaded from storage: made by someone else, so
// nothing in it reads as an edit made here.
function existing<T>(repo: Repo, value: T): DocHandle<T> {
  const handle = repo.create<T>();
  const made = Automerge.change(Automerge.init<T>({ actor: "00aa" }), (d) => {
    Object.assign(d as object, value);
  });
  handle.update(() => Automerge.load<T>(Automerge.save(made)));
  return handle;
}

function project() {
  const repo = new Repo();
  const note = existing<Note>(repo, { "@patchwork": { type: "note" }, text: "main" });
  const root = existing<Folder>(repo, { "@patchwork": { type: "folder" }, docs: [note.url] });
  const provider: HTMLElement & { repo?: Repo } = document.createElement("div");
  provider.setAttribute("doc-url", root.url);
  const child = document.createElement("div");
  provider.append(child);
  const dispose = OverlayProvider(provider, repo);
  const overlays = watch<OverlaysState>(child, { type: "overlays" });
  const send = <T>(selector: Record<string, unknown>) =>
    request(child, selector as never) as Promise<T>;
  const onCheckout = async () => (provider.repo as unknown as OverlayRepo).find<Note>(note.url);
  // Main's journal and groups, once there are any.
  const mainHistory = async () => {
    const url = root.doc()["@patchwork"].workspaceUrl;
    const refs = url ? (await repo.find<Workspace>(url)).doc().history : undefined;
    if (!refs) return undefined;
    return {
      journal: await repo.find<JournalDoc>(refs.journal),
      groups: await repo.find<HistoryGroupsDoc>(refs.groups),
    };
  };
  return { repo, note, root, child, overlays, send, onCheckout, mainHistory, dispose };
}

function watch<T>(element: HTMLElement, selector: Record<string, unknown>) {
  let latest: T | undefined;
  const waiters: (() => void)[] = [];
  subscribe(element, selector as never, (value) => {
    latest = value as T;
    for (const wake of waiters.splice(0)) wake();
  });
  const until = async (ready: (value: T) => boolean) => {
    while (latest === undefined || !ready(latest)) {
      await new Promise<void>((wake) => waiters.push(wake));
    }
    return latest;
  };
  return { until, latest: () => latest };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function edit(handle: DocHandle<Note>, text: string, time?: number) {
  handle.change(
    (d) => {
      d.text = text;
    },
    time ? { time } : {}
  );
  await settle();
}

// The journal's records, oldest first, with their messages.
function records(journal: DocHandle<JournalDoc>) {
  return Automerge.getChangesMetaSince(journal.doc() as Automerge.Doc<unknown>, [])
    .filter((change) => change.message)
    .map((change) => ({
      hash: change.hash,
      time: change.time,
      message: JSON.parse(change.message!) as JournalMessage,
    }));
}

const now = () => Math.floor(Date.now() / 1000);

describe("the journal", () => {
  it("records each edit made here, and nothing for just looking", async () => {
    const { note, overlays, onCheckout, mainHistory, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    await onCheckout();
    await settle();
    expect(await mainHistory()).toBeUndefined();

    await edit(note, "one");
    await edit(note, "two");
    const history = (await mainHistory())!;
    const made = records(history.journal);
    expect(made).toHaveLength(2);
    expect(made.every((record) => record.message.draft === null)).toBe(true);
    const heads = Object.keys(history.journal.doc().members[note.url].heads);
    expect(heads).toEqual([...note.heads()].map(() => expect.any(String)));
    expect(new Set(heads)).toEqual(new Set(Automerge.getHeads(note.doc() as Automerge.Doc<unknown>)));

    const groups = Object.values(history.groups.doc().groups);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ draft: null, changes: 2, last: made[1].hash });
    expect(Object.keys(groups[0].members)).toEqual([note.url]);
    dispose();
  });

  it("doesn't record edits made elsewhere", async () => {
    const { note, overlays, mainHistory, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    await edit(note, "here");
    const before = records((await mainHistory())!.journal).length;

    // Someone else's edit, synced in.
    const theirs = Automerge.change(Automerge.clone(note.doc() as Automerge.Doc<Note>), (d) => {
      d.text = "there";
    });
    note.update((doc) => Automerge.merge(doc, theirs));
    await settle();
    expect(records((await mainHistory())!.journal)).toHaveLength(before);
    dispose();
  });

  it("names points by record, exactly, even within a second", async () => {
    const { note, child, overlays, send, onCheckout, mainHistory, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const later = now() + 1000;
    await edit(note, "first", later);
    await edit(note, "second", later);
    const [first] = records((await mainHistory())!.journal);

    const history = watch<HistoryEntry[]>(child, { type: "overlay:history", overlay: null });
    await history.until((e) => e.some((entry) => entry.time === later));
    expect(await send({ type: "overlay:checkout", overlay: null, at: first.hash })).toBe(true);
    await overlays.until((s) => s.at === first.hash);
    await settle();
    expect((await onCheckout()).doc().text).toBe("first");
    dispose();
  });

  it("forks with a draft, and keeps the draft's edits to the draft's", async () => {
    const { repo, note, overlays, send, onCheckout, mainHistory, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    await edit(note, "on main");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await overlays.until((s) => s.checkedOut === draft);
    const refs = (await repo.find<DraftDoc>(draft)).doc().history!;
    const main = (await mainHistory())!;
    expect(refs.journal).not.toBe(main.journal.url);

    await edit(await onCheckout(), "in the draft");
    await settle();
    const journal = await repo.find<JournalDoc>(refs.journal);
    const made = records(journal);
    // Main's record came along with the fork; the draft's own is its.
    expect(made.map((record) => record.message.draft)).toEqual([null, draft]);
    expect(records(main.journal)).toHaveLength(1);
    dispose();
  });

  it("brings a merged draft's history into its target", async () => {
    const { repo, overlays, send, onCheckout, mainHistory, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    await overlays.until((s) => s.checkedOut === draft);
    await edit(await onCheckout(), "in the draft");
    const merge = await send<AutomergeUrl>({ type: "merge:create", source: draft, target: null });
    await overlays.until((s) => s.checkedOut === merge);
    expect(await send({ type: "merge:accept", merge })).toBe(true);
    await overlays.until((s) => s.checkedOut === null);
    await settle();

    const main = (await mainHistory())!;
    const made = records(main.journal);
    expect(made.some((record) => record.message.draft === draft)).toBe(true);
    expect(made.at(-1)!.message).toEqual({ draft: null, merge });
    const drafts = Object.values(main.groups.doc().groups).map((group) => group.draft);
    expect(drafts).toContain(draft);
    // The draft's history reads in main's.
    expect((await repo.find<DraftDoc>(draft)).doc().history).toBeDefined();
    dispose();
  });
});
