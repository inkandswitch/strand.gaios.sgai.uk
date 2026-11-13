import { save } from "@automerge/automerge/slim";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import { accept, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import { compareTrees, type Comparison, type Side } from "./compare.js";
import { canonical, find } from "./tree.js";

// The draft the checked-out one is compared with, or null when it isn't.
// `previewing` while it's only shown for as long as a menu item is hovered.
export type CompareAgainst = { draft: AutomergeUrl; previewing: boolean } | null;

// The files and folders that differ between the two drafts, and whose
// changes they are. Empty while there's nothing to compare with (`off`) and
// until the first comparison is done (`loading`).
export type CompareChanges = {
  status: "off" | "loading" | "ready";
  files: Record<AutomergeUrl, Side>;
  folders: Record<AutomergeUrl, Side>;
};

// The compared draft's version of a document, saved, or null when that
// draft doesn't have it.
export type ComparedVersion = { draft: AutomergeUrl; doc: Uint8Array | null } | null;

// The parts of the draft provider's `drafts` state read here.
type DraftsState = {
  workspace: AutomergeUrl;
  main: AutomergeUrl;
  checkedOut: AutomergeUrl;
  status: "verifying" | "ready" | "unavailable";
  drafts: { url: AutomergeUrl }[];
};

// The compared draft, checked out by a draft provider of its own that has no
// view: its repo reads the workspace as that draft has it.
type Theirs = {
  draft: AutomergeUrl;
  repo: Promise<Repo>;
  dispose: () => void;
};

const REFRESH_DEBOUNCE_MS = 300;

// Mounts inside a draft provider and compares the draft it has checked out
// with another of the workspace's drafts. Answers:
//   - `compare:against` → CompareAgainst, pushed on every change
//   - `compare:set { draft }` → compares with `draft` (null for nothing),
//     answers CompareAgainst
//   - `compare:preview { draft }` → compares with `draft` until it's
//     previewed with null, answers CompareAgainst
//   - `compare:changes` → CompareChanges, pushed on every change
//   - `compare:version { url }` → ComparedVersion, pushed whenever it changes
// Starts out comparing with the `against` attribute. Comparing with the
// checked-out draft, or one that's gone (merged, deleted, or never there),
// compares with nothing.
export function CompareProvider(element: HTMLElement & { repo: Repo }): () => void {
  const ours = draftRepoAbove(element) ?? element.repo;
  let drafts: DraftsState | undefined;
  let against = urlAttribute(element, "against");
  let preview: AutomergeUrl | null = null;
  let listed = new Set<AutomergeUrl>();
  let theirs: Theirs | null = null;
  let checkedOut: AutomergeUrl | undefined;
  let current: CompareAgainst = null;
  let changes: CompareChanges = { status: "off", files: {}, folders: {} };
  let comparison: Promise<Comparison | null> = Promise.resolve(null);
  let stopComparing = () => {};
  const againstSubscribers = new Set<(value: CompareAgainst) => void>();
  const changeSubscribers = new Set<(value: CompareChanges) => void>();
  const versionAnswers = new Set<() => void>();

  const onSubscribe = (event: SubscribeEvent) => {
    const { selector } = event.detail;
    switch (selector.type) {
      case "compare:against":
        accept<CompareAgainst>(event, (respond) => {
          respond(current);
          againstSubscribers.add(respond);
          return () => againstSubscribers.delete(respond);
        });
        return;

      case "compare:set":
      case "compare:preview": {
        const draft = selector.draft;
        if (draft !== null && !isValidAutomergeUrl(draft)) return;
        accept<CompareAgainst>(event, (respond) => {
          if (selector.type === "compare:set") {
            against = draft;
            preview = null;
          } else {
            preview = draft;
          }
          update();
          respond(current);
        });
        return;
      }

      case "compare:changes":
        accept<CompareChanges>(event, (respond) => {
          respond(changes);
          changeSubscribers.add(respond);
          return () => changeSubscribers.delete(respond);
        });
        return;

      case "compare:version": {
        const url = selector.url;
        if (!isValidAutomergeUrl(url)) return;
        accept<ComparedVersion>(event, (respond) => answerVersion(canonical(url), respond));
        return;
      }
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  const stopDrafts = subscribe<DraftsState>(element, { type: "drafts" }, (state) => {
    const urls = new Set(state.drafts.map((draft) => draft.url));
    const gone = (url: AutomergeUrl | null) =>
      url !== null && listed.has(url) && !urls.has(url) && !isMain(url, state);
    if (gone(against)) against = null;
    if (gone(preview)) preview = null;
    listed = urls;
    drafts = state;
    update();
  });

  return () => {
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    stopDrafts();
    stopComparing();
    theirs?.dispose();
    for (const stop of versionAnswers) stop();
    againstSubscribers.clear();
    changeSubscribers.clear();
  };

  // Work out what's compared with, and start comparing with it if that
  // changed, or if the checked-out draft did.
  function update() {
    if (!drafts || drafts.status !== "ready") return;
    const state = drafts;
    if (against && same(against, state.checkedOut, state)) against = null;
    const shown = preview && !same(preview, state.checkedOut, state) ? preview : against;
    const draft = shown && (isMain(shown, state) ? state.main : shown);
    const next: CompareAgainst = draft ? { draft, previewing: shown !== against } : null;

    const switched = (theirs?.draft ?? null) !== draft;
    const moved = checkedOut !== state.checkedOut;
    checkedOut = state.checkedOut;
    if (switched) {
      theirs?.dispose();
      theirs = draft ? mountTheirs(draft, state) : null;
    }
    if (switched || moved) compare();
    if (next?.draft !== current?.draft || next?.previewing !== current?.previewing) {
      current = next;
      for (const respond of againstSubscribers) respond(current);
    }
  }

  function mountTheirs(draft: AutomergeUrl, state: DraftsState): Theirs {
    const view = document.createElement("patchwork-view") as HTMLElement & { repo?: Repo };
    view.hidden = true;
    view.setAttribute("component", "patchwork-draft-provider");
    view.setAttribute("doc-url", state.workspace);
    if (!isMain(draft, state)) view.setAttribute("draft", draft);

    let stop = () => {};
    const repo = new Promise<Repo>((resolve) => {
      view.addEventListener(
        "patchwork:mounted",
        () => {
          stop = subscribe<DraftsState>(view, { type: "drafts" }, (theirState) => {
            if (theirState.status === "ready") resolve(view.repo!);
            else if (theirState.status === "unavailable") forget(draft);
          });
        },
        { once: true }
      );
    });
    element.prepend(view);
    return {
      draft,
      repo,
      dispose() {
        stop();
        view.remove();
      },
    };
  }

  // The compared draft can't be checked out: compare with nothing instead.
  function forget(draft: AutomergeUrl) {
    if (preview === draft) preview = null;
    if (against === draft) against = null;
    update();
  }

  function compare() {
    stopComparing();
    const target = theirs;
    if (!target || !drafts) {
      comparison = Promise.resolve(null);
      publish({ status: "off", files: {}, folders: {} });
      answerVersions();
      return;
    }
    const root = drafts.workspace;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let watched: DocHandle<unknown>[] = [];
    let theirFiles: Set<AutomergeUrl> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    };
    const watch = (next: DocHandle<unknown>[]) => {
      for (const handle of watched) handle.off("change", schedule);
      watched = [...new Set(next)];
      for (const handle of watched) handle.on("change", schedule);
    };
    const run = async (): Promise<Comparison | null> => {
      const run = ++seq;
      try {
        const result = await compareTrees(ours, await target.repo, root);
        if (disposed || run !== seq) return result;
        watch(result.watched);
        publish({ status: "ready", files: result.files, folders: result.folders });
        if (!theirFiles || !sameSet(theirFiles, result.theirFiles)) {
          theirFiles = result.theirFiles;
          answerVersions();
        }
        return result;
      } catch (err) {
        console.error("[compare] couldn't compare the drafts:", err);
        return null;
      }
    };
    const refresh = () => {
      comparison = run();
    };

    publish({ status: "loading", files: {}, folders: {} });
    refresh();
    answerVersions();
    stopComparing = () => {
      disposed = true;
      clearTimeout(timer);
      watch([]);
    };
  }

  function publish(next: CompareChanges) {
    changes = next;
    for (const respond of changeSubscribers) respond(changes);
  }

  // Answers again whenever the compared draft, whether it has the document,
  // or the document there changes.
  function answerVersion(url: AutomergeUrl, respond: (value: ComparedVersion) => void) {
    let stop = () => {};
    const answer = () => {
      stop();
      const target = theirs;
      if (!target) {
        stop = () => {};
        respond(null);
        return;
      }
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let handle: DocHandle<unknown> | null = null;
      const send = () => respond({ draft: target.draft, doc: save(handle!.doc() as never) });
      const onChange = () => {
        clearTimeout(timer);
        timer = setTimeout(send, REFRESH_DEBOUNCE_MS);
      };
      void (async () => {
        const [repo, result] = await Promise.all([target.repo, comparison]);
        if (cancelled) return;
        if (!result?.theirFiles.has(url)) return respond({ draft: target.draft, doc: null });
        handle = await find(repo, url);
        if (cancelled) return;
        if (!handle) return respond({ draft: target.draft, doc: null });
        send();
        handle.on("change", onChange);
      })();
      stop = () => {
        cancelled = true;
        clearTimeout(timer);
        handle?.off("change", onChange);
      };
    };
    answer();
    versionAnswers.add(answer);
    return () => {
      stop();
      versionAnswers.delete(answer);
    };
  }

  function answerVersions() {
    for (const answer of versionAnswers) answer();
  }
}

// Main goes by the main draft's url and by the workspace's.
function isMain(url: AutomergeUrl, state: DraftsState): boolean {
  return url === state.main || url === state.workspace;
}

function same(a: AutomergeUrl, b: AutomergeUrl, state: DraftsState): boolean {
  return a === b || (isMain(a, state) && isMain(b, state));
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

// The draft provider's own repo reads the draft without forking anything; a
// view's repo forks every doc of the draft it's asked for, and the comparison
// reads the whole tree.
function draftRepoAbove(element: HTMLElement): Repo | undefined {
  const provider = element.parentElement?.closest<HTMLElement & { repo?: Repo }>(
    '[component="patchwork-draft-provider"]'
  );
  return provider?.repo;
}

function urlAttribute(element: HTMLElement, name: string): AutomergeUrl | null {
  const raw = element.getAttribute(name);
  return raw && isValidAutomergeUrl(raw) ? raw : null;
}
