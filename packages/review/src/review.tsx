import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { subscribe, type JSONValue, type Selector } from "@inkandswitch/patchwork-providers";
import {
  createEffect,
  createSignal,
  For,
  Match,
  onCleanup,
  Switch,
  type Accessor,
} from "solid-js";
import { render } from "solid-js/web";

import {
  reviewDraft,
  type CountCache,
  type DraftDoc,
  type FileChange,
} from "./changes.js";
import "./review.css";

type DraftSelection = { checkedOut: AutomergeUrl | null };
type ReviewState =
  | { kind: "main" }
  | { kind: "loading" }
  | { kind: "ready"; changes: FileChange[] };

const REFRESH_DEBOUNCE_MS = 300;

// The files the checked-out draft changed under the project, each with the
// lines it added and removed. Clicking one opens it, where its diff shows.
export function renderReview(
  handle: DocHandle<unknown>,
  element: HTMLElement & { repo: Repo }
): () => void {
  return render(
    () => <Review rootUrl={handle.url} element={element} />,
    element
  );
}

function Review(props: { rootUrl: AutomergeUrl; element: HTMLElement & { repo: Repo } }) {
  const selection = useSubscription<DraftSelection>(props.element, {
    type: "draft:selection",
  });
  const selectedDocs = useSubscription<AutomergeUrl[]>(props.element, {
    type: "patchwork:selected-doc",
  });
  const state = useDraftReview(
    props.element.repo,
    props.rootUrl,
    () => selection()?.checkedOut
  );
  const isOpen = (url: AutomergeUrl) => selectedDocs()?.includes(url) ?? false;

  const open = (change: FileChange) => {
    props.element.dispatchEvent(
      new CustomEvent("patchwork:open-document", {
        detail: { url: change.location },
        bubbles: true,
        composed: true,
      })
    );
  };

  return (
    <div class="review">
      <Switch>
        <Match when={state().kind === "main"}>
          <p class="review__empty">
            Main is what drafts are compared against. Pick a draft to review its
            changes.
          </p>
        </Match>
        <Match when={state().kind === "loading"}>
          <p class="review__empty">Looking for changes…</p>
        </Match>
        <Match when={changesOf(state())?.length === 0}>
          <p class="review__empty">This draft hasn't changed anything yet.</p>
        </Match>
        <Match when={changesOf(state())}>
          {(changes) => (
            <ul class="review__list">
              <For each={changes()}>
                {(change) => (
                  <li>
                    <button
                      type="button"
                      class="review__change"
                      classList={{
                        "review__change--deleted": change.status === "deleted",
                        "review__change--open": isOpen(change.url),
                      }}
                      disabled={change.status === "deleted"}
                      title={change.path}
                      onClick={() => open(change)}>
                      <span class="review__name">
                        {baseName(change.path)}
                        <span class="review__dir">{dirName(change.path)}</span>
                      </span>
                      <Counts change={change} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Match>
      </Switch>
    </div>
  );
}

function Counts(props: { change: FileChange }) {
  const label = () => {
    const { status, added, removed } = props.change;
    if (added !== null || removed !== null) return null;
    return status === "modified" ? "changed" : status;
  };
  return (
    <span class="review__counts">
      {label() ?? (
        <>
          <span class="review__added">+{props.change.added}</span>
          <span class="review__removed">−{props.change.removed}</span>
        </>
      )}
    </span>
  );
}

// Works the review out again whenever the draft, a folder in the tree, or a
// changed file changes.
function useDraftReview(
  repo: Repo,
  rootUrl: AutomergeUrl,
  draftUrl: Accessor<AutomergeUrl | null | undefined>
): Accessor<ReviewState> {
  const [state, setState] = createSignal<ReviewState>({ kind: "loading" });
  const cache: CountCache = new Map();

  createEffect(() => {
    const url = draftUrl();
    if (url === undefined) return setState({ kind: "loading" });
    if (url === null) return setState({ kind: "main" });
    setState({ kind: "loading" });

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
        setState({ kind: "ready", changes: review.changes });
      } catch (err) {
        console.error("[review] couldn't work out the draft's changes:", err);
      }
    };

    repo.find<DraftDoc>(url).then(
      (handle) => {
        if (disposed) return;
        draft = handle;
        handle.on("change", schedule);
        void refresh();
      },
      (err) => console.error("[review] couldn't load the draft:", err)
    );
    onCleanup(() => {
      disposed = true;
      clearTimeout(timer);
      draft?.off("change", schedule);
      watch([]);
    });
  });

  return state;
}

function useSubscription<T extends JSONValue>(
  element: HTMLElement,
  selector: Selector
): Accessor<T | undefined> {
  const [value, setValue] = createSignal<T>();
  onCleanup(subscribe<T>(element, selector, (next) => setValue(() => next)));
  return value;
}

function changesOf(state: ReviewState): FileChange[] | undefined {
  return state.kind === "ready" ? state.changes : undefined;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}
