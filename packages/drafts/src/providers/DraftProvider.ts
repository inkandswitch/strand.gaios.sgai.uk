import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import type {
  DraftCheckpoint,
  DraftDoc,
  DraftList,
  DraftSelection,
  DraftStatus,
} from "../draft-types.js";
import {
  deleteDraft,
  forkDraft,
  mergeIntoParent,
  renameDraft,
} from "../draft-actions.js";
import { DraftRepo, baseRepo, type HandleDescriptor } from "../draft-repo.js";
import { createDraftState, type DraftState } from "./draft-state.js";

// How long the starting draft gets to show up among the root's drafts before
// it's reported unavailable. It's still taken if it shows up later.
const VERIFY_TIMEOUT_MS = 5000;

// Mounts on a draft root (a folder) and hands everything beneath it a
// `DraftRepo`, so documents resolve onto the checked-out draft and edits stay
// inside it. Answers:
//   - `draft:root-doc`  → the root's AutomergeUrl
//   - `draft:status`    → DraftStatus, pushed on every change
//   - `draft:selection` → DraftSelection, pushed on every change
//   - `draft:select { checkedOut, at }` → sets the selection, answers it
//     once it's checked out
//   - `draft:list`      → DraftList, pushed on every change
//   - `draft:fork { parent }` → forks `parent` (null for main), checks the
//     new draft out, answers its url
//   - `draft:merge { draft }` → merges it into its parent, answers where it
//     landed (null for main); checks that out if the draft was checked out
//   - `draft:delete { draft }` → unlinks it, answers its parent (null for
//     main); checks that out if the draft was checked out
//   - `draft:rename { draft, name }` → renames it (null for main), answers
//     the name
//   - `repo:handle-descriptor { url }` → where the views beneath read and
//     write `url` (see `DraftRepo.descriptorFor`), pushed again when that
//     moves
//
// The selection starts from the `draft` attribute and is otherwise only
// changed by `draft:select` and the commands above: the provider never reads
// or writes the URL. Until a starting draft is confirmed as a live draft of
// this root, documents beneath wait and the status is `verifying`; past
// VERIFY_TIMEOUT_MS it's `unavailable`, until the draft shows up or
// something else is selected. The checked-out draft is reflected onto
// `draft-url` for outside readers.
//
// Without a `doc-url` there is no root: every doc forks and there is no draft
// list; the `url` attribute then pins the draft.
export const DraftProvider = (
  element: HTMLElement & { repo?: Repo },
  inherited: Repo
) => {
  const repo = baseRepo(inherited);
  const rootUrl = urlAttribute(element, "doc-url");
  const seed = urlAttribute(element, "url");
  const initial = rootUrl ? urlAttribute(element, "draft") : null;

  let disposed = false;
  let selection: DraftSelection = { checkedOut: seed, at: null };
  let status: DraftStatus = initial ? "verifying" : "ready";
  let draft: DocHandle<DraftDoc> | null = null;
  let applySeq = 0;
  const selectionSubscribers = new Set<(selection: DraftSelection) => void>();
  const statusSubscribers = new Set<(status: DraftStatus) => void>();

  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  const draftRepo = new DraftRepo(repo, ready);
  element.repo = draftRepo as unknown as Repo;
  if (rootUrl) draftRepo.setRoot(rootUrl);

  const state: DraftState | null = rootUrl
    ? createDraftState({
        repo,
        docUrl: rootUrl,
        initial,
        selection: () => selection,
        select: (checkedOut) => void select({ checkedOut, at: null }),
      })
    : null;

  const verifyTimer = initial
    ? setTimeout(() => {
        if (status === "verifying") setStatus("unavailable");
      }, VERIFY_TIMEOUT_MS)
    : null;
  if (!initial) void settle();

  const onSubscribe = (event: SubscribeEvent) => {
    const { selector } = event.detail;

    switch (selector.type) {
      case "draft:root-doc":
        if (!rootUrl) return;
        accept<AutomergeUrl>(event, (respond) => respond(rootUrl));
        return;

      case "draft:status":
        accept<DraftStatus>(event, (respond) => {
          respond(status);
          statusSubscribers.add(respond);
          return () => statusSubscribers.delete(respond);
        });
        return;

      case "draft:selection":
        accept<DraftSelection>(event, (respond) => {
          selectionSubscribers.add(respond);
          void ready.then(() => {
            if (selectionSubscribers.has(respond)) respond(selection);
          });
          return () => selectionSubscribers.delete(respond);
        });
        return;

      case "draft:select": {
        const next = selectionFrom(selector);
        if (!next) return;
        accept<DraftSelection>(event, (respond) => {
          void select(next).then(() => respond(selection));
        });
        return;
      }

      case "draft:list":
        if (!state) return;
        accept<DraftList>(event, (respond) => state.subscribeList(respond));
        return;

      case "draft:fork": {
        const parent = optionalUrl(selector.parent);
        if (!state || parent === undefined) return;
        command(event, async () => {
          const root = await state.root();
          const forked = await forkDraft(repo, root, parent);
          await select({ checkedOut: forked, at: null });
          return forked;
        });
        return;
      }

      case "draft:merge": {
        const target = optionalUrl(selector.draft);
        if (!state || !target) return;
        command(event, async () => {
          const landed = await mergeIntoParent(repo, target);
          if (selection.checkedOut === target) {
            await select({ checkedOut: landed, at: null });
          }
          return landed;
        });
        return;
      }

      case "draft:delete": {
        const target = optionalUrl(selector.draft);
        if (!state || !target) return;
        command(event, async () => {
          const parent = await deleteDraft(repo, target);
          if (selection.checkedOut === target) {
            await select({ checkedOut: parent, at: null });
          }
          return parent;
        });
        return;
      }

      case "repo:handle-descriptor": {
        const url = selector.url;
        if (!isValidAutomergeUrl(url)) return;
        accept<HandleDescriptor>(event, (respond) => {
          let seq = 0;
          let last: AutomergeUrl | undefined;
          const answer = () => {
            const run = ++seq;
            draftRepo.descriptorFor(url).then(
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
          return draftRepo.onRemap(answer);
        });
        return;
      }

      case "draft:rename": {
        const target = optionalUrl(selector.draft);
        const name = selector.name;
        if (!state || target === undefined || typeof name !== "string") return;
        command(event, async () => {
          await renameDraft(repo, await state.root(), target, name);
          return name;
        });
        return;
      }
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    disposed = true;
    if (verifyTimer !== null) clearTimeout(verifyTimer);
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    selectionSubscribers.clear();
    statusSubscribers.clear();
    state?.dispose();
    draftRepo.dispose();
  };

  // Both the draft router (the starting draft confirmed, or a draft gone)
  // and the user end up here. Any selection settles a pending start.
  // Subscribers hear of it once every handle reads the new draft, so they can
  // look things up in it straight away; the promise resolves then too.
  function select(next: DraftSelection): Promise<void> {
    if (disposed) return Promise.resolve();
    selection = next;
    state?.selectionChanged();
    const applied = status === "ready" ? apply() : settle();
    return applied.then(() => {
      if (disposed || selection !== next) return;
      for (const respond of selectionSubscribers) respond(selection);
    });
  }

  // Apply the first confirmed selection, then let documents load.
  async function settle(): Promise<void> {
    if (verifyTimer !== null) clearTimeout(verifyTimer);
    await apply();
    if (disposed) return;
    setStatus("ready");
    release();
  }

  // Point the draft repo at the selection.
  async function apply(): Promise<void> {
    const seq = ++applySeq;
    const { checkedOut, at } = selection;
    element.setAttribute("draft-url", checkedOut ?? "");
    if ((draft?.url ?? null) !== checkedOut) {
      try {
        draft = checkedOut ? await repo.find<DraftDoc>(checkedOut) : null;
      } catch (err) {
        console.error(`[drafts] failed to load draft ${checkedOut}:`, err);
        return;
      }
    }
    if (disposed || seq !== applySeq) return;
    await draftRepo.checkout({ draft, at });
  }

  function setStatus(next: DraftStatus): void {
    if (status === next) return;
    status = next;
    for (const respond of statusSubscribers) respond(status);
  }
};

// Answer a one-shot command once it's done. A failure answers `null` after
// logging, so a waiting `request` doesn't hang.
function command<T>(event: SubscribeEvent, run: () => Promise<T>): void {
  accept<T | null>(event, (respond) => {
    run().then(respond, (err) => {
      console.error(`[drafts] ${event.detail.selector.type} failed:`, err);
      respond(null);
    });
  });
}

function urlAttribute(element: HTMLElement, name: string): AutomergeUrl | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw === "") return null;
  if (isValidAutomergeUrl(raw)) return raw;
  console.warn(
    `[drafts] <patchwork-view component="patchwork-draft-provider"> ` +
      `has an invalid ${name} attribute (got ${JSON.stringify(raw)})`
  );
  return null;
}

// A url, null, or undefined for anything else.
function optionalUrl(value: unknown): AutomergeUrl | null | undefined {
  if (value === null) return null;
  return isValidAutomergeUrl(value) ? value : undefined;
}

function selectionFrom(
  selector: Record<string, unknown>
): DraftSelection | null {
  const { checkedOut, at } = selector;
  if (checkedOut !== null && !isValidAutomergeUrl(checkedOut)) return null;
  if (typeof at !== "object") return null;
  return { checkedOut, at: at as DraftCheckpoint | null };
}
