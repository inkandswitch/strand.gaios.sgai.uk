import { beforeAll, describe, expect, it } from "vitest";
import * as Automerge from "@automerge/automerge";
import {
  Repo,
  initSubduction,
  decodeHeads,
  encodeHeads,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { request, subscribe } from "@inkandswitch/patchwork-providers";

import { groupRows, headsAt, rowsOf, HISTORY_GAP_SECONDS } from "./history.js";
import { OverlayProvider } from "./providers/OverlayProvider.js";
import type { OverlayRepo } from "./overlay-repo.js";
import type { HistoryEntry, Member, OverlaysState } from "./overlay-types.js";

type Note = { "@patchwork": { type: "note" }; text: string };
type Folder = { "@patchwork": { type: "folder" }; docs: AutomergeUrl[] };

const URL = "automerge:note" as AutomergeUrl;
const MINUTE = 60;

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

// A note edited at each of `times` (Unix seconds), one edit each.
function noteAt(times: number[]) {
  let doc = Automerge.change(Automerge.init<{ text: string }>(), { time: times[0] - 1 }, (d) => {
    d.text = "0";
  });
  for (const [i, time] of times.entries()) {
    doc = Automerge.change(doc, { time }, (d) => {
      d.text = String(i + 1);
    });
  }
  return doc;
}

describe("history entries", () => {
  it("are bursts of changes, split by a ten-minute pause", () => {
    const start = 1_000_000;
    const doc = noteAt([start, start + 5 * MINUTE, start + 30 * MINUTE, start + 31 * MINUTE]);
    const entries = groupRows(rowsOf(doc, URL, encodeHeads([])), null);
    const heads = Automerge.getHeads(doc);
    expect(entries.map((entry) => [entry.start, entry.time])).toEqual([
      [start + 30 * MINUTE, start + 31 * MINUTE],
      [start - 1, start + 5 * MINUTE],
    ]);
    expect(entries[0].id).toBe(heads[0]);
    expect(entries[0].members).toEqual([URL]);
  });

  it("leave out what the version they start from has", () => {
    const start = 1_000_000;
    const doc = noteAt([start, start + 1]);
    const forked = Automerge.getHeads(doc);
    const later = Automerge.change(doc, { time: start + HISTORY_GAP_SECONDS * 3 }, (d) => {
      d.text = "later";
    });
    const rows = rowsOf(later, URL, encodeHeads(forked as string[]));
    expect(rows.map((row) => row.time)).toEqual([start + HISTORY_GAP_SECONDS * 3]);
  });
});

describe("a document at a point in history", () => {
  const start = 1_000_000;
  const doc = noteAt([start, start + MINUTE, start + 2 * MINUTE]);
  const textAt = (heads: string[]) => Automerge.view(doc, heads as Automerge.Heads).text;

  it("has every change made by then", () => {
    const heads = headsAt(doc, { hash: "elsewhere", time: start + MINUTE + 10 })!;
    expect(textAt(decodeHeads(heads))).toBe("2");
  });

  it("is undefined when the document was made later", () => {
    expect(headsAt(doc, { hash: "elsewhere", time: start - 100 })).toBeUndefined();
  });

  it("stays within the version an overlay reads it at", () => {
    const firstEdit = Automerge.getAllChanges(doc).map((c) => Automerge.decodeChange(c))[1].hash;
    const heads = headsAt(doc, { hash: "elsewhere", time: start + 10 * MINUTE }, encodeHeads([firstEdit]))!;
    expect(textAt(decodeHeads(heads))).toBe("1");
  });
});

// --- Through the overlay provider --------------------------------------------

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
  const onCheckout = async () =>
    (provider.repo as unknown as OverlayRepo).find<Note>(note.url);
  return { repo, note, root, child, overlays, send, onCheckout, dispose };
}

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

async function edit(handle: DocHandle<Note>, text: string, time: number) {
  handle.change(
    (d) => {
      d.text = text;
    },
    { time }
  );
  await settle();
}

const now = () => Math.floor(Date.now() / 1000);

describe("an overlay's history", () => {
  it("is main's members' changes, newest first", async () => {
    const { note, child, overlays, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const later = now() + 1000;
    await edit(note, "one", later);
    await edit(note, "two", later + 60 * MINUTE);
    const history = watch<HistoryEntry[]>(child, { type: "overlay:history", overlay: null });
    const entries = await history.until((e) => e.length === 3);
    expect(entries.map((entry) => entry.time)).toEqual([later + 60 * MINUTE, later, expect.any(Number)]);
    expect(entries.every((entry) => entry.overlay === null)).toBe(true);
    dispose();
  });

  it("can be checked out at a point, read-only", async () => {
    const { note, child, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const later = now() + 1000;
    await edit(note, "one", later);
    await edit(note, "two", later + 60 * MINUTE);
    const history = watch<HistoryEntry[]>(child, { type: "overlay:history", overlay: null });
    const [, earlier] = await history.until((e) => e.length === 3);

    expect(await send({ type: "overlay:checkout", overlay: null, at: earlier.id })).toBe(true);
    const state = await overlays.until((s) => s.at === earlier.id);
    expect(state.checkedOut).toBeNull();
    const viewed = await onCheckout();
    await settle();
    expect(viewed.doc().text).toBe("one");
    expect(viewed.isReadOnly()).toBe(true);

    await send({ type: "overlay:checkout", overlay: null });
    await overlays.until((s) => s.at === null);
    await settle();
    expect(viewed.doc().text).toBe("two");
    expect(viewed.isReadOnly()).toBe(false);
    dispose();
  });

  it("answers members and descriptors at a point", async () => {
    const { repo, note, child, overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const later = now() + 1000;
    await edit(note, "one", later);
    await edit(note, "two", later + 60 * MINUTE);
    const history = watch<HistoryEntry[]>(child, { type: "overlay:history", overlay: null });
    const [, earlier] = await history.until((e) => e.length === 3);

    const where = await send<{ url: AutomergeUrl; cloneUrl?: AutomergeUrl }>({
      type: "repo:handle-descriptor",
      url: note.url,
      overlay: null,
      at: earlier.id,
    });
    expect((await repo.find<Note>(where.cloneUrl ?? where.url)).doc().text).toBe("one");

    const members = watch<Member[]>(child, { type: "overlay:members", overlay: null, at: earlier.id });
    const live = watch<Member[]>(child, { type: "overlay:members", overlay: null });
    const [pinned, current] = await Promise.all([
      members.until((m) => m.length === 2),
      live.until((m) => m.length === 2),
    ]);
    const headsOf = (list: Member[]) => list.find((m) => m.url === note.url)!.heads.join();
    expect(headsOf(pinned)).not.toBe(headsOf(current));
    dispose();
  });

  it("for a draft, is its own changes, then its parent's from before it was forked", async () => {
    const { note, child, overlays, send, onCheckout, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    const draft = await send<AutomergeUrl>({ type: "draft:create", parent: null });
    const later = now() + 1000;
    await edit(await onCheckout(), "draft", later);
    // Main after the fork isn't the draft's history.
    await edit(note, "main later", later + 60 * MINUTE);

    const history = watch<HistoryEntry[]>(child, { type: "overlay:history", overlay: draft });
    const entries = await history.until((e) => e.length >= 2);
    expect(entries[0]).toMatchObject({ overlay: draft, time: later, members: [note.url] });
    expect(entries.slice(1).every((entry) => entry.overlay === null && entry.time < later)).toBe(true);

    // Checked out where it was forked, it reads as main did then.
    expect(await send({ type: "overlay:checkout", overlay: draft, at: entries[1].id })).toBe(true);
    await overlays.until((s) => s.at === entries[1].id);
    await settle();
    expect((await onCheckout()).doc().text).toBe("main");
    dispose();
  });

  it("refuses a point that isn't in the history", async () => {
    const { overlays, send, dispose } = project();
    await overlays.until((s) => s.status === "ready");
    expect(await send({ type: "overlay:checkout", overlay: null, at: "nope" })).toBeNull();
    dispose();
  });
});
