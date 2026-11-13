import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import type {
  DraftDoc,
  DraftEntry,
  DraftSelection,
  DraftStatus,
  DraftsState,
} from "../draft-types.js";
import {
  deleteDraft,
  discardPreview,
  forkDraft,
  mergeInto,
  previewMerge,
  renameDraft,
} from "../draft-actions.js";
import { DraftRepo, baseRepo, type HandleDescriptor } from "../draft-repo.js";
import { createDraftState, type DraftState } from "./draft-state.js";

// How long the starting draft gets to show up among the root's drafts before
// it's reported unavailable. It's still taken if it shows up later.
const VERIFY_TIMEOUT_MS = 5000;

// Mounts on a workspace (the folder its drafts cover) and hands everything
// beneath it a `DraftRepo`, so documents resolve onto the checked-out draft
// and edits stay inside it. Answers:
//   - `drafts` → DraftsState, pushed on every change
//   - `draft:checkout { draft }` → checks it out, answers `{ draft }` once
//     every handle reads it
//   - `draft:create { from }` → forks `from`, checks the new draft out,
//     answers `{ draft }`
//   - `draft:merge { draft, into? }` → merges it into `into`, or its parent,
//     answers `{ into }`; checks that out if the draft was checked out.
//     `into` can't be the draft or forked from it
//   - `draft:preview-merge { draft, into }` → a hidden draft showing what
//     the merge would leave `into` as, answers `{ preview }`
//   - `draft:discard { draft }` → throws a preview away, answers `{ draft }`
//   - `draft:delete { draft }` → unlinks it, answers `{ parent }`; checks
//     that out if the draft was checked out
//   - `draft:rename { draft, name }` → renames it, answers `{ name }`
//   - `repo:handle-descriptor { url }` → where the views beneath read and
//     write `url` (see `DraftRepo.descriptorFor`), pushed again when that
//     moves
// Main is named by its url in `drafts` (`main`); the workspace's url names it
// too. A failed command answers null.
//
// The checkout starts from the `draft` attribute and is otherwise only
// changed by the commands above: the provider never reads or writes the URL.
// Until a starting draft is confirmed as a live draft of the workspace,
// documents beneath wait and the status is `verifying`; past
// VERIFY_TIMEOUT_MS it's `unavailable`, until the draft shows up or something
// else is checked out. The checked-out draft is reflected onto `draft-url`
// for outside readers.
//
// Without a `doc-url` there is no workspace: every doc forks, nothing is
// answered but `repo:handle-descriptor`, and the `url` attribute pins the
// draft.
export const DraftProvider = (
  element: HTMLElement & { repo?: Repo },
  inherited: Repo
) => {
  const repo = baseRepo(inherited);
  const rootUrl = urlAttribute(element, "doc-url");
  const seed = urlAttribute(element, "url");
  const initial = rootUrl ? urlAttribute(element, "draft") : null;

  let disposed = false;
  let selection: DraftSelection = { checkedOut: seed };
  // What subscribers have been told is checked out: it only moves once every
  // handle reads the new draft.
  let announced: AutomergeUrl | null = initial ?? seed;
  let status: DraftStatus = initial ? "verifying" : "ready";
  let draft: DocHandle<DraftDoc> | null = null;
  let applySeq = 0;
  const subscribers = new Set<(state: DraftsState) => void>();

  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  const draftRepo = new DraftRepo(repo, ready);
  element.repo = draftRepo as unknown as Repo;
  if (rootUrl) draftRepo.setRoot(rootUrl);

  const drafts: DraftState | null = rootUrl
    ? createDraftState({
        repo,
        docUrl: rootUrl,
        initial,
        selection: () => selection,
        select: (checkedOut) => void select(checkedOut),
      })
    : null;
  const stopList = drafts?.subscribeList(() => publish()) ?? (() => {});

  const verifyTimer = initial
    ? setTimeout(() => {
        if (status === "verifying") setStatus("unavailable");
      }, VERIFY_TIMEOUT_MS)
    : null;
  if (!initial) void settle();

  const onSubscribe = (event: SubscribeEvent) => {
    const { selector } = event.detail;

    switch (selector.type) {
      case "drafts":
        if (!drafts) return;
        accept<DraftsState>(event, (respond) => {
          respond(state());
          subscribers.add(respond);
          return () => subscribers.delete(respond);
        });
        return;

      case "draft:checkout": {
        const target = draftIn(selector.draft);
        if (!drafts || target === undefined) return;
        command(event, async () => {
          await select(target);
          return { draft: external(selection.checkedOut) };
        });
        return;
      }

      case "draft:create": {
        const from = draftIn(selector.from);
        if (!drafts || from === undefined) return;
        command(event, async () => {
          const created = await forkDraft(repo, await drafts.root(), from);
          await select(created);
          return { draft: created };
        });
        return;
      }

      case "draft:merge": {
        const target = draftIn(selector.draft);
        if (!drafts || !target) return;
        const into = selector.into === undefined ? parentOf(target) : draftIn(selector.into);
        if (into === undefined || !canMergeInto(target, into)) return;
        // Checked out first: a checked-out draft that goes away falls back to main.
        command(event, async () => {
          if (selection.checkedOut === target) await select(into);
          await mergeInto(repo, await drafts.root(), target, into);
          return { into: external(into) };
        });
        return;
      }

      case "draft:preview-merge": {
        const target = draftIn(selector.draft);
        if (!drafts || !target) return;
        const into = draftIn(selector.into);
        if (into === undefined || !canMergeInto(target, into)) return;
        command(event, async () => ({
          preview: await previewMerge(repo, await drafts.root(), target, into),
        }));
        return;
      }

      case "draft:discard": {
        const preview = draftIn(selector.draft);
        if (!drafts || !preview) return;
        command(event, async () => {
          await discardPreview(repo, preview);
          return { draft: preview };
        });
        return;
      }

      case "draft:delete": {
        const target = draftIn(selector.draft);
        const parent = target ? parentOf(target) : undefined;
        if (!drafts || !target || parent === undefined) return;
        command(event, async () => {
          if (selection.checkedOut === target) await select(parent);
          await deleteDraft(repo, target);
          return { parent: external(parent) };
        });
        return;
      }

      case "draft:rename": {
        const target = draftIn(selector.draft);
        const name = selector.name;
        if (!drafts || target === undefined || typeof name !== "string") return;
        command(event, async () => {
          await renameDraft(repo, await drafts.root(), target, name);
          return { name };
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
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    disposed = true;
    if (verifyTimer !== null) clearTimeout(verifyTimer);
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    subscribers.clear();
    stopList();
    drafts?.dispose();
    draftRepo.dispose();
  };

  function state(): DraftsState {
    const list = drafts!.list();
    return {
      workspace: rootUrl!,
      main: list.main,
      checkedOut: announced ?? list.main,
      status,
      drafts: list.drafts,
    };
  }

  function publish(): void {
    if (disposed || !drafts) return;
    const next = state();
    for (const respond of subscribers) respond(next);
  }

  // A draft named in a command: null for main, by its url or the
  // workspace's; undefined for anything that isn't a url.
  function draftIn(value: unknown): AutomergeUrl | null | undefined {
    if (!isValidAutomergeUrl(value)) return undefined;
    if (value === rootUrl || value === drafts?.list().main) return null;
    return value;
  }

  function external(url: AutomergeUrl | null): AutomergeUrl {
    return url ?? drafts?.list().main ?? rootUrl!;
  }

  // The listed draft `draft` was forked off: null for main, undefined when
  // `draft` isn't listed.
  function parentOf(draft: AutomergeUrl): AutomergeUrl | null | undefined {
    const parent = listed().get(draft)?.parent;
    return parent ? draftIn(parent) : undefined;
  }

  // Whether `draft` can merge into `into` (null for main): a listed draft
  // that isn't `draft` or forked from it.
  function canMergeInto(draft: AutomergeUrl, into: AutomergeUrl | null): boolean {
    const byUrl = listed();
    let cursor = byUrl.get(external(into));
    if (!cursor) return false;
    while (cursor) {
      if (cursor.url === draft) return false;
      cursor = cursor.parent ? byUrl.get(cursor.parent) : undefined;
    }
    return true;
  }

  function listed(): Map<AutomergeUrl, DraftEntry> {
    return new Map(drafts!.list().drafts.map((entry) => [entry.url, entry]));
  }

  // Both the draft router (the starting draft confirmed, or a draft gone)
  // and the user end up here. Any checkout settles a pending start.
  // Subscribers hear of it once every handle reads the new draft, so they can
  // look things up in it straight away; the promise resolves then too.
  function select(checkedOut: AutomergeUrl | null): Promise<void> {
    if (disposed) return Promise.resolve();
    const next = { checkedOut };
    selection = next;
    drafts?.selectionChanged();
    const applied = status === "ready" ? apply() : settle();
    return applied.then(() => {
      if (disposed || selection !== next) return;
      announced = selection.checkedOut;
      publish();
    });
  }

  // Apply the first confirmed checkout, then let documents load.
  async function settle(): Promise<void> {
    if (verifyTimer !== null) clearTimeout(verifyTimer);
    await apply();
    if (disposed) return;
    announced = selection.checkedOut;
    setStatus("ready");
    release();
  }

  // Point the draft repo at the selection. The main draft is bookkeeping and
  // never resolved through, so checking it out checks out main.
  async function apply(): Promise<void> {
    const seq = ++applySeq;
    const { checkedOut } = selection;
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
    await draftRepo.checkout({
      draft: draft?.doc()?.isMain ? null : draft,
      at: null,
    });
  }

  function setStatus(next: DraftStatus): void {
    if (status === next) return;
    status = next;
    publish();
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
