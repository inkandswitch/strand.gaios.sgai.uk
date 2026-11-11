import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { accept, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import { reviewDraft, type CountCache, type DraftDoc } from "./changes.js";

/**
 * What the checked-out draft changed under the root, and whether to show only
 * that. `files` are the changed files' urls, `folders` the folders holding
 * them; both are empty on main, which nothing is compared against, and while
 * the draft's changes are being worked out.
 */
export type ChangeView = {
  status: "main" | "loading" | "ready";
  files: AutomergeUrl[];
  folders: AutomergeUrl[];
  onlyChanged: boolean;
};

type DraftSelection = { checkedOut: AutomergeUrl | null };

const REFRESH_DEBOUNCE_MS = 300;

// Mounts inside a draft provider and answers:
//   - `review:changes` → ChangeView, pushed on every change
//   - `review:show-changed { onlyChanged }` → sets it (ignored on main),
//     answers the view
// The changes are worked out again whenever the draft, a folder in the tree,
// or a changed file changes. Switching to main shows everything again.
export function ReviewProvider(element: HTMLElement & { repo: Repo }): () => void {
  const repo = draftRepoAbove(element) ?? element.repo;
  const subscribers = new Set<(view: ChangeView) => void>();
  const cache: CountCache = new Map();
  let view: ChangeView = { status: "loading", files: [], folders: [], onlyChanged: false };
  let root: AutomergeUrl | undefined;
  let checkedOut: AutomergeUrl | null | undefined;
  let stopWatching = () => {};

  const onSubscribe = (event: SubscribeEvent) => {
    const { selector } = event.detail;
    switch (selector.type) {
      case "review:changes":
        accept<ChangeView>(event, (respond) => {
          respond(view);
          subscribers.add(respond);
          return () => subscribers.delete(respond);
        });
        return;

      case "review:show-changed": {
        const onlyChanged = selector.onlyChanged;
        if (typeof onlyChanged !== "boolean") return;
        accept<ChangeView>(event, (respond) => {
          if (view.status !== "main") publish({ ...view, onlyChanged });
          respond(view);
        });
        return;
      }
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  const unsubscribeRoot = subscribe<AutomergeUrl>(element, { type: "draft:root-doc" }, (url) => {
    root = url;
    restart();
  });
  const unsubscribeSelection = subscribe<DraftSelection>(
    element,
    { type: "draft:selection" },
    (selection) => {
      if (selection.checkedOut === checkedOut) return;
      checkedOut = selection.checkedOut;
      restart();
    }
  );

  return () => {
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    unsubscribeRoot();
    unsubscribeSelection();
    stopWatching();
    subscribers.clear();
  };

  function restart() {
    stopWatching();
    stopWatching = () => {};
    if (!root || checkedOut === undefined) return;
    if (checkedOut === null) {
      publish({ status: "main", files: [], folders: [], onlyChanged: false });
      return;
    }
    publish({ ...view, status: "loading", files: [], folders: [] });
    stopWatching = watchDraft(repo, root, checkedOut, cache, (files, folders) =>
      publish({ ...view, status: "ready", files, folders })
    );
  }

  function publish(next: ChangeView) {
    view = next;
    for (const respond of subscribers) respond(view);
  }
}

// The draft provider's own repo reads the draft without forking anything; a
// view's repo forks every doc of the draft it's asked for, and the review
// reads the whole tree.
function draftRepoAbove(element: HTMLElement): Repo | undefined {
  const provider = element.parentElement?.closest<HTMLElement & { repo?: Repo }>(
    '[component="patchwork-draft-provider"]'
  );
  return provider?.repo;
}

// Reports the draft's changed files and the folders holding them, first once
// it has loaded, then after each change that could change them.
function watchDraft(
  repo: Repo,
  rootUrl: AutomergeUrl,
  draftUrl: AutomergeUrl,
  cache: CountCache,
  report: (files: AutomergeUrl[], folders: AutomergeUrl[]) => void
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let draft: DocHandle<DraftDoc> | undefined;
  let watched: DocHandle<unknown>[] = [];
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
  };
  const watch = (next: DocHandle<unknown>[]) => {
    for (const handle of watched) handle.off("change", schedule);
    watched = [...new Set(next)];
    for (const handle of watched) handle.on("change", schedule);
  };
  const refresh = async () => {
    const doc = draft?.doc();
    if (!doc || disposed) return;
    const run = ++seq;
    try {
      const review = await reviewDraft(repo, rootUrl, doc, cache);
      if (disposed || run !== seq) return;
      watch(review.watched);
      report(
        review.changes.map((change) => change.url),
        review.folders
      );
    } catch (err) {
      console.error("[review] couldn't work out the draft's changes:", err);
    }
  };

  repo.find<DraftDoc>(draftUrl).then(
    (handle) => {
      if (disposed) return;
      draft = handle;
      handle.on("change", schedule);
      void refresh();
    },
    (err) => console.error("[review] couldn't load the draft:", err)
  );

  return () => {
    disposed = true;
    clearTimeout(timer);
    draft?.off("change", schedule);
    watch([]);
  };
}
