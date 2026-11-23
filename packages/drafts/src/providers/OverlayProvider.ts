import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import {
  acceptMerge,
  createDraft,
  createMerge,
  deleteOverlay,
  ensureIndex,
  renameDraft,
} from "../overlay-actions.js";
import { OverlayRepo, baseRepo, openOverlay } from "../overlay-repo.js";
import type {
  HandleDescriptor,
  Member,
  MergeDoc,
  Overlay,
  OverlaysState,
  OverlayStatus,
} from "../overlay-types.js";
import { createOverlayList } from "./overlay-list.js";

// How long the starting overlay gets to show up among the root's overlays
// before it's reported unavailable. It's still taken if it shows up later.
const LOAD_TIMEOUT_MS = 5000;

// Mounts on a root (`doc-url`) and hands everything beneath it an
// `OverlayRepo`, so members resolve onto the checked-out overlay and edits
// stay inside it. Answers:
//   - `overlays` → OverlaysState, pushed on every change
//   - `overlay:members { overlay }` → Member[], pushed on every change
//   - `repo:handle-descriptor { url, overlay? }` → where `url` is read and
//     written, in `overlay` or else the checked-out one, pushed again when
//     that moves
//   - `overlay:checkout { overlay }` → true once every handle reads it
//   - `overlay:delete { overlay }` → true
//   - `draft:create { parent }` → the new draft's url, checked out
//   - `draft:rename { draft, name }` → true
//   - `merge:create { source, target }` → the merge's url, checked out
//   - `merge:accept { merge }` → true, with the target checked out
// Main is null wherever an overlay is named. A command that couldn't be done
// answers null.
//
// The checkout starts from the `overlay` attribute and is otherwise only
// changed by the commands above. Until that overlay is listed, documents
// beneath wait and the status is `loading`; past LOAD_TIMEOUT_MS it's
// `unavailable`, until the overlay shows up or something else is checked out.
export const OverlayProvider = (element: HTMLElement & { repo?: Repo }, inherited: Repo) => {
  const repo = baseRepo(inherited);
  const rootUrl = urlAttribute(element, "doc-url");
  if (!rootUrl) {
    console.error('[drafts] <patchwork-view component="patchwork-overlay-provider"> needs a doc-url');
    return () => {};
  }
  const initial = urlAttribute(element, "overlay");

  let disposed = false;
  let selection: Overlay = null;
  let selections = 0;
  // What subscribers have been told is checked out: it only moves once every
  // handle reads the new overlay.
  let announced: Overlay = initial;
  let status: OverlayStatus = initial ? "loading" : "ready";
  let applySeq = 0;
  const subscribers = new Set<(state: OverlaysState) => void>();

  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  const readers = new Map<string, OverlayRepo>();
  const overlayRepo = new OverlayRepo(repo, { ready });
  element.repo = overlayRepo as unknown as Repo;
  overlayRepo.setRoot(rootUrl);

  const list = createOverlayList({
    repo,
    rootUrl,
    initial,
    checkedOut: () => selection,
    select: (overlay) => void select(overlay),
  });
  const stopList = list.subscribe(() => {
    forgetReaders();
    publish();
  });

  const loadTimer = initial
    ? setTimeout(() => {
        if (status === "loading") setStatus("unavailable");
      }, LOAD_TIMEOUT_MS)
    : null;
  if (!initial) void settle();

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector as { type: string; [key: string]: unknown };

    switch (selector.type) {
      case "overlays":
        accept<OverlaysState>(event, (respond) => {
          respond(state());
          subscribers.add(respond);
          return () => subscribers.delete(respond);
        });
        return;

      case "overlay:members": {
        const overlay = overlayIn(selector.overlay);
        if (overlay === undefined) return refuse(event);
        accept<Member[]>(event, (respond) => {
          const reader = readerFor(overlay);
          let live = true;
          const answer = () =>
            void reader.members().then((members) => live && respond(members));
          answer();
          const stop = reader.onMembers(answer);
          return () => {
            live = false;
            stop();
          };
        });
        return;
      }

      case "repo:handle-descriptor": {
        const url = selector.url;
        if (!isValidAutomergeUrl(url)) return;
        const named = selector.overlay !== undefined;
        const overlay = named ? overlayIn(selector.overlay) : null;
        if (overlay === undefined) return refuse(event);
        accept<HandleDescriptor>(event, (respond) => {
          const reader = named ? readerFor(overlay) : overlayRepo;
          let seq = 0;
          let last: AutomergeUrl | undefined;
          const answer = () => {
            const run = ++seq;
            reader.descriptorFor(url).then(
              (descriptor) => {
                const backing = descriptor.cloneUrl ?? descriptor.url;
                if (disposed || run !== seq || backing === last) return;
                last = backing;
                respond(descriptor);
              },
              (err) => console.error(`[drafts] couldn't resolve ${url}:`, err)
            );
          };
          answer();
          return reader.onRemap(answer);
        });
        return;
      }

      case "overlay:checkout": {
        const overlay = overlayIn(selector.overlay);
        if (overlay === undefined || !list.has(overlay)) return refuse(event);
        command(event, async () => {
          await select(overlay);
          return true;
        });
        return;
      }

      case "overlay:delete": {
        const overlay = overlayIn(selector.overlay);
        if (!overlay || !list.has(overlay)) return refuse(event);
        command(event, async () => {
          if (selection === overlay) await select(null);
          await deleteOverlay(repo, await ensureIndex(repo, await list.root()), overlay);
          return true;
        });
        return;
      }

      case "draft:create": {
        const parent = overlayIn(selector.parent);
        if (parent === undefined || (parent && !list.draft(parent))) return refuse(event);
        command(event, async () => {
          const draft = await createDraft(repo, await list.root(), parent);
          await select(draft);
          return draft;
        });
        return;
      }

      case "draft:rename": {
        const draft = overlayIn(selector.draft);
        const name = selector.name;
        if (!draft || !list.draft(draft) || typeof name !== "string") return refuse(event);
        command(event, async () => {
          await renameDraft(repo, draft, name);
          return true;
        });
        return;
      }

      case "merge:create": {
        const source = overlayIn(selector.source);
        const target = overlayIn(selector.target);
        const isInput = (input: Overlay | undefined) =>
          input !== undefined && (input === null || !!list.draft(input));
        if (!isInput(source) || !isInput(target) || source === target) return refuse(event);
        command(event, async () => {
          const merge = await createMerge(repo, await list.root(), source!, target!);
          await select(merge);
          return merge;
        });
        return;
      }

      case "merge:accept": {
        const url = overlayIn(selector.merge);
        const merge = url ? list.merge(url) : undefined;
        if (!url || !merge) return refuse(event);
        command(event, async () => {
          const reader = readerFor(url);
          await select(merge.target);
          await acceptMerge(
            repo,
            await ensureIndex(repo, await list.root()),
            await repo.find<MergeDoc>(url),
            {
              members: async () => (await reader.members()).map((member) => member.url),
              doc: async (member) => (await reader.find(member)).doc() as never,
            }
          );
          return true;
        });
        return;
      }
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    disposed = true;
    if (loadTimer !== null) clearTimeout(loadTimer);
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    subscribers.clear();
    stopList();
    list.dispose();
    overlayRepo.dispose();
    for (const reader of readers.values()) reader.dispose();
    readers.clear();
  };

  function state(): OverlaysState {
    const { drafts, merges } = list.lists();
    return { checkedOut: announced, status, drafts, merges };
  }

  function publish(): void {
    if (disposed) return;
    const next = state();
    for (const respond of subscribers) respond(next);
  }

  // A repo reading `overlay`, whatever is checked out: for a view of another
  // overlay's version of a member, and for another overlay's members.
  function readerFor(overlay: Overlay): OverlayRepo {
    const key = overlay ?? "main";
    let reader = readers.get(key);
    if (reader) return reader;
    let opened!: () => void;
    reader = new OverlayRepo(repo, { ready: new Promise<void>((resolve) => (opened = resolve)) });
    reader.setRoot(rootUrl!);
    const created = reader;
    openOverlay(repo, overlay)
      .then((checkout) => created.checkout(checkout))
      .catch((err) => console.error(`[drafts] couldn't open ${overlay}:`, err))
      .finally(opened);
    readers.set(key, reader);
    return reader;
  }

  // Readers of overlays that went away.
  function forgetReaders(): void {
    for (const [key, reader] of readers) {
      if (key === "main" || list.has(key as AutomergeUrl)) continue;
      reader.dispose();
      readers.delete(key);
    }
  }

  // Both the list (the starting overlay listed, or the checked-out one gone)
  // and the commands end up here. Any checkout settles a pending start.
  // Subscribers hear of it once every handle reads the new overlay; the
  // promise resolves then too.
  function select(next: Overlay): Promise<void> {
    if (disposed) return Promise.resolve();
    selection = next;
    const mine = ++selections;
    list.selectionChanged();
    const applied = status === "ready" ? apply() : settle();
    return applied.then(() => {
      if (disposed || mine !== selections) return;
      announced = selection;
      publish();
    });
  }

  // Apply the first checkout, then let documents load.
  async function settle(): Promise<void> {
    if (loadTimer !== null) clearTimeout(loadTimer);
    await apply();
    if (disposed) return;
    announced = selection;
    setStatus("ready");
    release();
  }

  // Point the overlay repo at the selection.
  async function apply(): Promise<void> {
    const seq = ++applySeq;
    const target = selection;
    let checkout;
    try {
      checkout = await openOverlay(repo, target);
    } catch (err) {
      console.error(`[drafts] failed to load overlay ${target}:`, err);
      return;
    }
    if (disposed || seq !== applySeq) return;
    await overlayRepo.checkout(checkout);
  }

  function setStatus(next: OverlayStatus): void {
    if (status === next) return;
    status = next;
    publish();
  }
};

// An overlay named in a message: null for main, undefined for anything that
// isn't one.
function overlayIn(value: unknown): Overlay | undefined {
  if (value === null) return null;
  return isValidAutomergeUrl(value) ? value : undefined;
}

// Answer a one-shot command once it's done. A failure answers null after
// logging, so a waiting `request` doesn't hang.
function command<T>(event: SubscribeEvent, run: () => Promise<T>): void {
  accept<T | null>(event, (respond) => {
    run().then(respond, (err) => {
      console.error(`[drafts] ${event.detail.selector.type} failed:`, err);
      respond(null);
    });
  });
}

// A message this provider answers but can't act on: answered null, so a
// waiting `request` doesn't hang.
function refuse(event: SubscribeEvent): void {
  accept<null>(event, (respond) => respond(null));
}

function urlAttribute(element: HTMLElement, name: string): AutomergeUrl | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw === "") return null;
  if (isValidAutomergeUrl(raw)) return raw;
  console.warn(
    `[drafts] <patchwork-view component="patchwork-overlay-provider"> ` +
      `has an invalid ${name} attribute (got ${JSON.stringify(raw)})`
  );
  return null;
}
