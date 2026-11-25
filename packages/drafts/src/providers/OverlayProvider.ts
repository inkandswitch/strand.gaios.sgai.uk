import { Automerge } from "@automerge/automerge-repo/slim";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { accept, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import {
  acceptMerge,
  createDraft,
  createMerge,
  deleteOverlay,
  ensureWorkspace,
  findWorkspace,
  publishMerge,
  renameDraft,
} from "../overlay-actions.js";
import { autoOf, conflictState, findConflicts, hasConflictPlugin } from "../conflicts.js";
import type { Point } from "../history.js";
import { OverlayRepo, baseRepo, openOverlay } from "../overlay-repo.js";
import type {
  At,
  HandleDescriptor,
  HistoryEntry,
  Member,
  MergeConflicts,
  MergeDoc,
  MergeEntry,
  Overlay,
  OverlaysState,
  OverlayStatus,
} from "../overlay-types.js";
import { createHistoryRecorder } from "./history-recorder.js";
import { createOverlayHistory } from "./overlay-history.js";
import { createOverlayList } from "./overlay-list.js";

// How long the starting overlay gets to show up among the root's overlays
// before it's reported unavailable. It's still taken if it shows up later.
const LOAD_TIMEOUT_MS = 5000;

// Conflicts are worked out again this long after an input or the merge last
// changed.
const CONFLICTS_DEBOUNCE_MS = 150;

// Mounts on a root (`doc-url`) and hands everything beneath it an
// `OverlayRepo`, so members resolve onto the checked-out overlay and edits
// stay inside it. Answers:
//   - `overlays` → OverlaysState, pushed on every change
//   - `overlay:members { overlay, at? }` → Member[], pushed on every change
//   - `overlay:history { overlay }` → HistoryEntry[], the newest first,
//     pushed on every change
//   - `repo:handle-descriptor { url, overlay?, at? }` → where `url` is read
//     and written, in `overlay` (at `at`) or else the checked-out one, pushed
//     again when that moves
//   - `overlay:checkout { overlay, at? }` → true once every handle reads it,
//     as it was at `at` (a point in its history, read-only) if that's set;
//     null for a merge at a point, or a point not in its history
//   - `overlay:delete { overlay }` → true
//   - `draft:create { parent }` → the new draft's url, checked out
//   - `draft:rename { draft, name }` → true
//   - `merge:create { source, target }` → the pair's pull request, or a new
//     preview, checked out
//   - `merge:publish { merge }` → true, the preview now a pull request
//   - `merge:accept { merge }` → true, with the target checked out; null
//     while the merge has open conflicts
//   - `merge:conflicts { merge }` → MergeConflicts, pushed on every change
// Main is null wherever an overlay is named. A merge is named by its url
// whether it's listed (a pull request) or not (a preview). A command that
// couldn't be done answers null.
//
// The checkout starts from the `overlay` and `at` attributes and is otherwise only
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
  const initialAt = element.getAttribute("at") || null;

  let disposed = false;
  let selection: Overlay = null;
  let selectionAt: At = initialAt;
  // Where `selectionAt` is, once it's been found in the overlay's history.
  let point: Point | null = null;
  let selections = 0;
  // What subscribers have been told is checked out: it only moves once every
  // handle reads the new overlay.
  let announced: Overlay = initial;
  let announcedAt: At = null;
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
    // The starting overlay comes with the starting point; one that went away
    // falls back to main's working copy.
    select: (overlay) => void select(overlay, overlay === initial ? initialAt : null),
  });
  const history = createOverlayHistory({
    repo,
    rootUrl,
    readerFor: (overlay) => readerFor(overlay, null),
    workspace: async () => findWorkspace(repo, await list.root()),
  });
  // Who's signed in, for the journal's records.
  let contact: AutomergeUrl | undefined;
  const stopContact = subscribe<AutomergeUrl>(element, { type: "patchwork:contact" }, (url) => {
    if (typeof url === "string" && isValidAutomergeUrl(url)) contact = url;
  });
  const recorder = createHistoryRecorder({
    repo,
    overlayRepo,
    workspace: async () => ensureWorkspace(repo, await list.root()),
    author: () => contact,
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
        const at = atIn(selector.at);
        if (overlay === undefined || at === undefined) return refuse(event);
        accept<Member[]>(event, (respond) => {
          const reader = readerFor(overlay, at);
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

      case "overlay:history": {
        const overlay = overlayIn(selector.overlay);
        if (overlay === undefined) return refuse(event);
        accept<HistoryEntry[]>(event, (respond) => {
          let live = true;
          let seq = 0;
          let last = "";
          const answer = () => {
            const run = ++seq;
            history.entries(overlay).then(
              (entries) => {
                const key = JSON.stringify(entries);
                if (!live || run !== seq || key === last) return;
                last = key;
                respond(entries);
              },
              (err) => console.error(`[drafts] couldn't read the history of ${overlay}:`, err)
            );
          };
          answer();
          let stop = history.watch(overlay, answer);
          // Readers of overlays that went off the list are let go, and new
          // ones made: watch whatever reads the overlays now.
          const stopList = list.subscribe(() => {
            stop();
            stop = history.watch(overlay, answer);
            answer();
          });
          return () => {
            live = false;
            stop();
            stopList();
          };
        });
        return;
      }

      case "repo:handle-descriptor": {
        const url = selector.url;
        if (!isValidAutomergeUrl(url)) return;
        const named = selector.overlay !== undefined;
        const overlay = named ? overlayIn(selector.overlay) : null;
        const at = named ? atIn(selector.at) : null;
        if (overlay === undefined || at === undefined) return refuse(event);
        accept<HandleDescriptor>(event, (respond) => {
          const reader = named ? readerFor(overlay, at) : overlayRepo;
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
        const at = atIn(selector.at);
        if (overlay === undefined || at === undefined) return refuse(event);
        command(event, async () => {
          if (!list.has(overlay) && !(await list.preview(overlay!))) return null;
          if (at && (list.merge(overlay!) || !(await history.point(overlay, at)))) return null;
          await select(overlay, at);
          return true;
        });
        return;
      }

      case "overlay:delete": {
        const overlay = overlayIn(selector.overlay);
        if (!overlay) return refuse(event);
        command(event, async () => {
          const merge = list.merge(overlay) ?? (await list.preview(overlay));
          if (!list.has(overlay) && !merge) return null;
          // Leaving a merge goes back to the draft it would have merged.
          if (selection === overlay) await select(merge ? merge.source : null);
          await deleteOverlay(repo, await ensureWorkspace(repo, await list.root()), overlay);
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
          if (!list.merge(merge)) await list.preview(merge);
          await select(merge);
          return merge;
        });
        return;
      }

      case "merge:publish": {
        const url = overlayIn(selector.merge);
        if (!url) return refuse(event);
        command(event, async () => {
          if (!(list.merge(url) ?? (await list.preview(url)))) return null;
          await publishMerge(repo, await list.root(), url);
          return true;
        });
        return;
      }

      case "merge:conflicts": {
        const url = overlayIn(selector.merge);
        if (!url) return refuse(event);
        accept<MergeConflicts>(event, (respond) => {
          let live = true;
          let stops: (() => void)[] = [];
          let timer: ReturnType<typeof setTimeout> | undefined;
          let last = "";
          const answer = async () => {
            const merge = list.merge(url) ?? (await list.preview(url));
            if (!live || !merge) return;
            const conflicts = await conflictsOf(merge);
            const key = JSON.stringify(conflicts);
            if (!live || key === last) return;
            last = key;
            respond(conflicts);
          };
          const soon = () => {
            clearTimeout(timer);
            timer = setTimeout(() => void answer(), CONFLICTS_DEBOUNCE_MS);
          };
          void (async () => {
            const merge = list.merge(url) ?? (await list.preview(url));
            if (!live || !merge) return;
            stops = [merge.source, merge.target, merge.url].map((overlay) =>
              readerFor(overlay, null).onMembers(soon)
            );
            await answer();
          })();
          return () => {
            live = false;
            clearTimeout(timer);
            for (const stop of stops) stop();
          };
        });
        return;
      }

      case "merge:accept": {
        const url = overlayIn(selector.merge);
        if (!url) return refuse(event);
        command(event, async () => {
          const merge = list.merge(url) ?? (await list.preview(url));
          if (!merge) return null;
          const conflicts = await conflictsOf(merge);
          const open = Object.values(conflicts).some((each) =>
            each.some((conflict) => conflict.state === "open")
          );
          if (open) return null;
          // Read first: checking the target out takes a preview off the
          // list, and its reader with it.
          const reader = readerFor(url, null);
          const members = (await reader.members()).map((member) => member.url);
          const docs = new Map(
            await Promise.all(
              members.map(async (member) => [member, (await reader.find(member)).doc()] as const)
            )
          );
          await select(merge.target);
          await acceptMerge(
            repo,
            await ensureWorkspace(repo, await list.root()),
            await repo.find<MergeDoc>(url),
            {
              members: async () => members,
              doc: async (member) => docs.get(member) as never,
            },
            contact
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
    stopContact();
    recorder.dispose();
    list.dispose();
    overlayRepo.dispose();
    for (const reader of readers.values()) reader.dispose();
    readers.clear();
  };

  function state(): OverlaysState {
    const { drafts, merges } = list.lists();
    return { checkedOut: announced, at: announcedAt, status, drafts, merges };
  }

  function publish(): void {
    if (disposed) return;
    const next = state();
    for (const respond of subscribers) respond(next);
  }

  // A repo reading `overlay` (as it was at `at`), whatever is checked out:
  // for a view of another version of a member, and for another version's
  // members.
  function readerFor(overlay: Overlay, at: At): OverlayRepo {
    const key = `${overlay ?? "main"}@${at ?? ""}`;
    let reader = readers.get(key);
    if (reader) return reader;
    let opened!: () => void;
    reader = new OverlayRepo(repo, { ready: new Promise<void>((resolve) => (opened = resolve)) });
    reader.setRoot(rootUrl!);
    const created = reader;
    (async () => {
      const where = at ? await history.point(overlay, at) : undefined;
      if (at && !where) console.warn(`[drafts] ${at} isn't in the history of ${overlay}`);
      await created.checkout(await openOverlay(repo, overlay), where ?? null);
    })()
      .catch((err) => console.error(`[drafts] couldn't open ${overlay}:`, err))
      .finally(opened);
    readers.set(key, reader);
    return reader;
  }

  // Every conflict of `merge`, by member, and how each went. Only members
  // whose versions differ between source and target can have any.
  async function conflictsOf(merge: MergeEntry): Promise<MergeConflicts> {
    const [source, target, merged] = [merge.source, merge.target, merge.url].map((overlay) =>
      readerFor(overlay, null)
    );
    const [sourceMembers, targetMembers] = await Promise.all([source.members(), target.members()]);
    const targetHeads = new Map(targetMembers.map((member) => [member.url, member.heads]));
    const out: MergeConflicts = {};
    for (const member of sourceMembers) {
      const heads = targetHeads.get(member.url);
      if (!heads || sameHeads(heads, member.heads)) continue;
      try {
        const sourceDoc = (await source.find<unknown>(member.url)).doc() as Automerge.Doc<unknown>;
        if (!hasConflictPlugin(sourceDoc)) continue;
        const targetDoc = (await target.find<unknown>(member.url)).doc() as Automerge.Doc<unknown>;
        const mergedDoc = (await merged.find<unknown>(member.url)).doc() as Automerge.Doc<unknown>;
        const versions = { source: sourceDoc, target: targetDoc };
        const found = await findConflicts({ ...versions, auto: autoOf(sourceDoc, targetDoc) });
        if (!found.length) continue;
        out[member.url] = found.map((conflict) => ({
          ...conflict,
          state: conflictState(conflict, { ...versions, merged: mergedDoc }),
        }));
      } catch (err) {
        console.warn(`[drafts] couldn't look for conflicts in ${member.url}:`, err);
      }
    }
    return out;
  }

  // Readers of overlays that went away.
  function forgetReaders(): void {
    for (const [key, reader] of readers) {
      const overlay = key.slice(0, key.indexOf("@"));
      if (overlay === "main" || list.has(overlay as AutomergeUrl)) continue;
      reader.dispose();
      readers.delete(key);
    }
  }

  // Both the list (the starting overlay listed, or the checked-out one gone)
  // and the commands end up here. Any checkout settles a pending start.
  // Subscribers hear of it once every handle reads the new overlay; the
  // promise resolves then too.
  function select(next: Overlay, at: At = null): Promise<void> {
    if (disposed) return Promise.resolve();
    selection = next;
    selectionAt = at;
    const mine = ++selections;
    list.selectionChanged();
    const applied = status === "ready" ? apply() : settle();
    return applied.then(() => {
      if (disposed || mine !== selections) return;
      announced = selection;
      announcedAt = point ? selectionAt : null;
      publish();
    });
  }

  // Apply the first checkout, then let documents load.
  async function settle(): Promise<void> {
    if (loadTimer !== null) clearTimeout(loadTimer);
    await apply();
    if (disposed) return;
    announced = selection;
    announcedAt = point ? selectionAt : null;
    setStatus("ready");
    release();
  }

  // Point the overlay repo at the selection.
  async function apply(): Promise<void> {
    const seq = ++applySeq;
    const target = selection;
    const at = selectionAt;
    let checkout;
    let where: Point | undefined;
    try {
      checkout = await openOverlay(repo, target);
      where = at && checkout?.kind !== "merge" ? await history.point(target, at) : undefined;
    } catch (err) {
      console.error(`[drafts] failed to load overlay ${target}:`, err);
      return;
    }
    if (disposed || seq !== applySeq) return;
    if (at && !where) console.warn(`[drafts] ${at} isn't in the history of ${target}`);
    point = where ?? null;
    await overlayRepo.checkout(checkout, point);
  }

  function setStatus(next: OverlayStatus): void {
    if (status === next) return;
    status = next;
    publish();
  }
};

// A point in history named in a message: null (or absent) for the working
// copy, undefined for anything that isn't one.
function atIn(value: unknown): At | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value !== "" ? value : undefined;
}

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

function sameHeads(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((head) => b.includes(head));
}
