import { save } from "@automerge/automerge/slim";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import {
  accept,
  request,
  subscribe,
  type SubscribeEvent,
} from "@inkandswitch/patchwork-providers";

import {
  compareMerge,
  compareTrees,
  type Comparison,
  type Ghost,
  type Mark,
} from "./compare.js";
import { canonical, find } from "./tree.js";

// The draft the checked-out one is compared with, or null when it isn't.
// `previewing` while it's only shown for as long as a menu item is hovered.
// `merging` while the checked-out draft's merge into it is being looked over;
// `after` is then the hidden draft showing what the merge would leave it as,
// once it's made.
export type CompareAgainst = {
  draft: AutomergeUrl;
  previewing: boolean;
  merging: boolean;
  after: AutomergeUrl | null;
} | null;

// How the files and folders differ: between the two drafts (`compare`), or
// between the merge's target before and after (`merge`). Empty while there's
// nothing to compare with (`off`) and until the first comparison is done
// (`loading`). `ghosts` are what the checked-out draft doesn't have.
export type CompareChanges = {
  status: "off" | "loading" | "ready";
  mode: "compare" | "merge";
  files: Record<AutomergeUrl, Mark>;
  folders: Record<AutomergeUrl, Mark>;
  ghosts: Ghost[];
};

// The compared draft's version of a document, saved, or null when that
// draft doesn't have it. Merging, that's the target's version before the
// merge, and `removed` says the merge takes the document out.
export type ComparedVersion = {
  draft: AutomergeUrl;
  doc: Uint8Array | null;
  removed: boolean;
} | null;

// The parts of the draft provider's `drafts` state read here.
type DraftsState = {
  workspace: AutomergeUrl;
  main: AutomergeUrl;
  checkedOut: AutomergeUrl;
  status: "verifying" | "ready" | "unavailable";
  drafts: { url: AutomergeUrl }[];
};

// A draft checked out by a draft provider of its own that has no view: its
// repo reads the workspace as that draft has it.
type Mounted = {
  draft: AutomergeUrl;
  repo: Promise<Repo>;
  dispose: () => void;
};

// The checked-out draft's merge into `into`, and its preview once made.
type Merging = {
  from: AutomergeUrl;
  into: AutomergeUrl;
  preview: AutomergeUrl | null;
};

const REFRESH_DEBOUNCE_MS = 300;

const OFF: CompareChanges = { status: "off", mode: "compare", files: {}, folders: {}, ghosts: [] };

// Mounts inside a draft provider and compares the draft it has checked out
// with another of the workspace's drafts. Answers:
//   - `compare:against` → CompareAgainst, pushed on every change
//   - `compare:set { draft }` → compares with `draft` (null for nothing),
//     answers CompareAgainst
//   - `compare:preview { draft }` → compares with `draft` until it's
//     previewed with null, answers CompareAgainst
//   - `compare:changes` → CompareChanges, pushed on every change
//   - `compare:version { url }` → ComparedVersion, pushed whenever it changes
//   - `merge:start { into }` → looks over the checked-out draft's merge into
//     `into`, answers CompareAgainst
//   - `merge:cancel` → stops, answers CompareAgainst
//   - `merge:commit` → merges, which checks `into` out, answers `{ into }`
// Starts out comparing with the `against` attribute. Comparing with the
// checked-out draft, or one that's gone (merged, deleted, or never there),
// compares with nothing. Checking out another draft stops a merge.
export function CompareProvider(element: HTMLElement & { repo: Repo }): () => void {
  const ours = draftRepoAbove(element) ?? element.repo;
  let drafts: DraftsState | undefined;
  let against = urlAttribute(element, "against");
  let preview: AutomergeUrl | null = null;
  let merging: Merging | null = null;
  let listed = new Set<AutomergeUrl>();
  let theirs: Mounted | null = null;
  let after: Mounted | null = null;
  let checkedOut: AutomergeUrl | undefined;
  let current: CompareAgainst = null;
  let settled = false;
  let changes: CompareChanges = OFF;
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
          // Until the drafts are in, `against` may still be dropped.
          if (settled) respond(current);
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
        accept<ComparedVersion>(event, (respond) =>
          answerVersion(canonical(url), respond)
        );
        return;
      }

      case "merge:start": {
        const into = selector.into;
        const state = drafts;
        if (!state || !isValidAutomergeUrl(into) || !isListed(into, state)) return;
        if (same(into, state.checkedOut, state)) return;
        accept<CompareAgainst>(event, (respond) => {
          startMerge(state, into);
          respond(current);
        });
        return;
      }

      case "merge:cancel":
        accept<CompareAgainst>(event, (respond) => {
          stopMerge();
          respond(current);
        });
        return;

      case "merge:commit": {
        const merge = merging;
        if (!merge) return;
        accept<{ into: AutomergeUrl } | null>(event, (respond) => {
          void commitMerge(merge).then(respond, (err) => {
            console.error("[compare] couldn't merge:", err);
            respond(null);
          });
        });
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
    if (merging && (gone(merging.into) || !same(merging.from, state.checkedOut, state))) {
      discard(merging);
      merging = null;
    }
    listed = urls;
    drafts = state;
    update();
  });

  return () => {
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    stopDrafts();
    stopComparing();
    theirs?.dispose();
    after?.dispose();
    if (merging) discard(merging);
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
    const shown = merging
      ? merging.into
      : preview && !same(preview, state.checkedOut, state)
        ? preview
        : against;
    const draft = shown && (isMain(shown, state) ? state.main : shown);
    const previewDraft = merging?.preview ?? null;
    const next: CompareAgainst = draft
      ? {
          draft,
          previewing: !merging && shown !== against,
          merging: !!merging,
          after: previewDraft,
        }
      : null;

    const switched = (theirs?.draft ?? null) !== draft;
    const previewSwitched = (after?.draft ?? null) !== previewDraft;
    const moved = checkedOut !== state.checkedOut;
    checkedOut = state.checkedOut;
    if (switched) {
      theirs?.dispose();
      theirs = draft ? mount(draft, state, () => forget(draft)) : null;
    }
    if (previewSwitched) {
      after?.dispose();
      after = previewDraft ? mount(previewDraft, state, stopMerge) : null;
    }
    if (switched || previewSwitched || moved) compare();
    const announce = !settled || !sameAgainst(next, current);
    settled = true;
    if (announce) {
      current = next;
      for (const respond of againstSubscribers) respond(current);
    }
  }

  function startMerge(state: DraftsState, into: AutomergeUrl) {
    if (merging) discard(merging);
    const merge: Merging = { from: state.checkedOut, into, preview: null };
    merging = merge;
    preview = null;
    update();
    void request<{ preview: AutomergeUrl } | null>(element, {
      type: "draft:preview-merge",
      draft: state.checkedOut,
      into,
    }).then((answer) => {
      if (merging !== merge) {
        if (answer) discard({ ...merge, preview: answer.preview });
        return;
      }
      if (!answer) return stopMerge();
      merge.preview = answer.preview;
      update();
    });
  }

  function stopMerge() {
    if (!merging) return;
    discard(merging);
    merging = null;
    update();
  }

  // Merged by the draft provider, which checks `into` out; the merged draft
  // is compared with nothing after.
  async function commitMerge(merge: Merging): Promise<{ into: AutomergeUrl } | null> {
    against = null;
    const answer = await request<{ into: AutomergeUrl } | null>(element, {
      type: "draft:merge",
      draft: merge.from,
      into: merge.into,
    });
    if (merging === merge) {
      discard(merge);
      merging = null;
      update();
    }
    return answer;
  }

  function discard(merge: Merging) {
    if (!merge.preview) return;
    void request(element, { type: "draft:discard", draft: merge.preview });
  }

  function mount(draft: AutomergeUrl, state: DraftsState, unavailable: () => void): Mounted {
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
            else if (theirState.status === "unavailable") unavailable();
          });
        },
        { once: true }
      );
    });
    element.append(view);
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
    if (merging?.into === draft) stopMerge();
    update();
  }

  function compare() {
    stopComparing();
    const target = theirs;
    const result = after;
    const mode = merging ? "merge" : "compare";
    if (!target || !drafts) {
      comparison = Promise.resolve(null);
      publish(OFF);
      answerVersions();
      return;
    }
    if (merging && !result) {
      comparison = Promise.resolve(null);
      publish({ ...OFF, status: "loading", mode });
      answerVersions();
      return;
    }
    const root = drafts.workspace;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let watched: DocHandle<unknown>[] = [];
    let known: Comparison | undefined;
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
        const result = after
          ? await compareMerge(ours, await target.repo, await after.repo, root)
          : await compareTrees(ours, await target.repo, root);
        if (disposed || run !== seq) return result;
        watch(result.watched);
        const { files, folders, ghosts } = result;
        publish({ status: "ready", mode, files, folders, ghosts });
        if (!known || !sameFiles(known, result)) {
          known = result;
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

    publish({ ...OFF, status: "loading", mode });
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
      let removed = false;
      const send = () =>
        respond({ draft: target.draft, doc: save(handle!.doc() as never), removed });
      const onChange = () => {
        clearTimeout(timer);
        timer = setTimeout(send, REFRESH_DEBOUNCE_MS);
      };
      void (async () => {
        const [repo, result] = await Promise.all([target.repo, comparison]);
        if (cancelled) return;
        removed = !!result?.afterFiles && !result.afterFiles.has(url);
        const missing = { draft: target.draft, doc: null, removed };
        if (!result?.theirFiles.has(url)) return respond(missing);
        handle = await find(repo, url);
        if (cancelled) return;
        if (!handle) return respond(missing);
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

  function isListed(url: AutomergeUrl, state: DraftsState): boolean {
    return isMain(url, state) || state.drafts.some((draft) => draft.url === url);
  }
}

// Main goes by the main draft's url and by the workspace's.
function isMain(url: AutomergeUrl, state: DraftsState): boolean {
  return url === state.main || url === state.workspace;
}

function same(a: AutomergeUrl, b: AutomergeUrl, state: DraftsState): boolean {
  return a === b || (isMain(a, state) && isMain(b, state));
}

function sameAgainst(a: CompareAgainst, b: CompareAgainst): boolean {
  if (!a || !b) return a === b;
  return (
    a.draft === b.draft &&
    a.previewing === b.previewing &&
    a.merging === b.merging &&
    a.after === b.after
  );
}

function sameFiles(a: Comparison, b: Comparison): boolean {
  return (
    sameSet(a.theirFiles, b.theirFiles) &&
    (a.afterFiles && b.afterFiles ? sameSet(a.afterFiles, b.afterFiles) : a.afterFiles === b.afterFiles)
  );
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
