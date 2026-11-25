import "./sidebar.css";
import type {} from "@inkandswitch/patchwork-elements";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { subscribe, subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import { CuteText } from "cute.txt/solid";
import { useDocument } from "solid-automerge";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import {
  docUrlOf,
  firstLine,
  isWholeDocument,
  threadUrlOf,
  type CommentThread,
} from "./comments";
import { CONTEXT, locationUrl, type CommentsContext } from "./context";
import { findSegments, titleOf, useResolved, useTheirThreads, useThreadsOf } from "./hooks";
import { describeRefs, type Described } from "./refs";
import { relativeTime } from "./relative-time";

type Scope = "view" | "project";
type FocusDoc = {
  selection: Record<AutomergeUrl, true>;
  highlight: Record<AutomergeUrl, true>;
};

/** A thread in the list: the checked-out draft's (live), or the compared draft's (a copy). */
type Item = {
  key: string;
  docUrl: AutomergeUrl;
  thread: CommentThread;
  draft: "ours" | "theirs";
  /** ours only: the thread's live url */
  threadUrl?: AutomergeUrl;
};

const SCOPE_KEY = "gaios-comments:scope";

function storedScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "view" ? "view" : "project";
  } catch {
    return "project";
  }
}

export function Sidebar(props: { element: HTMLElement & { repo: Repo } }) {
  const element = props.element;
  const repo = element.repo;

  const context = subscribe<CommentsContext | null>(element, { type: CONTEXT } as never, null);
  const [chosen, setScopeSignal] = createSignal<Scope>(storedScope());
  // The frame may say which threads to list (its column's scope); then it
  // also titles the sidebar, and the sidebar shows neither.
  const framed = () => !!context()?.scope;
  const scope = (): Scope => {
    const given = context()?.scope;
    return given ? (given === "open" ? "view" : "project") : chosen();
  };
  const setScope = (next: Scope) => {
    setScopeSignal(next);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      /* private mode */
    }
  };

  const openDocs = createMemo<AutomergeUrl[]>(() => context()?.openDocs ?? [], [], {
    equals: sameList,
  });
  const comparing = () => !!context()?.theirs;

  // ---------------------------------------------------------------- threads
  // Every thread in the project is kept in its root document.
  const rootUrl = () => context()?.projectUrl;
  const rootUrls = createMemo<AutomergeUrl[]>(() => (rootUrl() ? [rootUrl()!] : []), [], {
    equals: sameList,
  });
  const rootThreads = useThreadsOf(repo, rootUrls);
  const theirRoot = useTheirThreads(element, rootUrls, comparing);

  const ourItems = createMemo<Item[]>(() => {
    const url = rootUrl();
    const found = url ? rootThreads().get(url) : undefined;
    if (!found) return [];
    return found.threads
      .filter((thread) => thread.refs.length > 0)
      .map((thread) => {
        const threadUrl = threadUrlOf(found.handle as DocHandle<unknown>, thread.id);
        return { key: threadUrl, docUrl: docUrlOf(thread.refs[0]), thread, draft: "ours" as const, threadUrl };
      });
  });

  // While comparing, the threads only the other draft has: ones it added, or
  // ones we've resolved or removed since.
  const theirItems = createMemo<Item[]>(() => {
    const url = rootUrl();
    const others = url ? theirRoot().get(url) : undefined;
    if (!url || !others?.length) return [];
    const known = new Set(
      (rootThreads().get(url)?.handle.doc()?.["@comments"]?.threads ?? []).map((t) => t.id)
    );
    return others
      .filter((thread) => thread.refs.length > 0 && !known.has(thread.id))
      .map((thread) => ({
        key: `${url}#theirs/${thread.id}`,
        docUrl: docUrlOf(thread.refs[0]),
        thread,
        draft: "theirs" as const,
      }));
  });

  // Threads whose target says to hide them (an image's anchors cleared when
  // it was replaced), reported by their rows as they're described.
  const [hidden, setHidden] = createSignal(new Set<string>());
  const report = (key: string, described: Described) =>
    setHidden((previous) => {
      if (previous.has(key) === described.hidden) return previous;
      const next = new Set(previous);
      if (described.hidden) next.add(key);
      else next.delete(key);
      return next;
    });

  const allItems = createMemo<Item[]>(() => [...ourItems(), ...theirItems()]);
  // The threads on what's open: the ones that can overlap a tool's selection.
  const inView = createMemo<Item[]>(() => {
    const open = new Set(openDocs());
    return allItems().filter((item) => open.has(item.docUrl) && !hidden().has(item.key));
  });

  // Grouped by the document they're on; with "Open files", only what's open,
  // in the order it opened.
  type Group = { docUrl: AutomergeUrl; items: Item[] };
  const groups = createMemo<Group[]>(() => {
    const byDoc = new Map<AutomergeUrl, Item[]>();
    for (const item of allItems()) {
      const list = byDoc.get(item.docUrl);
      if (list) list.push(item);
      else byDoc.set(item.docUrl, [item]);
    }
    let out = [...byDoc].map(([docUrl, items]) => ({ docUrl, items }));
    if (scope() === "view") {
      const order = new Map(openDocs().map((url, i) => [url, i]));
      out = out
        .filter((g) => order.has(g.docUrl))
        .sort((a, b) => order.get(a.docUrl)! - order.get(b.docUrl)!);
    }
    return out;
  });
  const groupByDoc = createMemo(() => new Map(groups().map((g) => [g.docUrl, g])));
  // Rows are keyed by url, not by item: the items are rebuilt on every change
  // to the root, and a remounted card would lose its draft editor.
  const groupKeys = createMemo(() => groups().map((g) => g.docUrl), [], { equals: sameList });
  const visibleCount = (group: Group) => group.items.filter((i) => !hidden().has(i.key)).length;

  // ---------------------------------------------------------------- focus
  const [focusDoc, focusHandle] = subscribeDoc<FocusDoc>(element, { type: "patchwork:focus" });
  const selectedUrls = createMemo<AutomergeUrl[]>(
    () => Object.keys(focusDoc()?.selection ?? {}) as AutomergeUrl[],
    [],
    { equals: sameList }
  );
  const selectedHandles = useResolved(repo, selectedUrls);

  const partRefs = (item: Item) => item.thread.refs.filter((r) => !isWholeDocument(r));
  const ourParts = createMemo<Item[]>(() =>
    inView().filter((i) => i.draft === "ours" && partRefs(i).length > 0)
  );
  const allRefs = createMemo<AutomergeUrl[]>(
    () => [...new Set(ourParts().flatMap(partRefs))],
    [],
    { equals: sameList }
  );
  const refHandles = useResolved(repo, allRefs);

  const overlapping = createMemo<string[]>(() => {
    const selection = selectedHandles();
    if (selection.length === 0) return [];
    const byUrl = new Map(refHandles().map((h) => [h.url, h]));
    return ourParts()
      .filter((item) =>
        partRefs(item).some((ref) => {
          const target = byUrl.get(ref);
          return (
            !!target &&
            selection.some((s) => {
              try {
                return s.url === target.url || s.overlaps(target) || s.contains(target);
              } catch {
                return false;
              }
            })
          );
        })
      )
      .map((item) => item.key);
  });

  // A tiebreaker when several threads share a target, and how a thread with
  // nothing to overlap (a whole-document one, or the other draft's) gets picked.
  const [pinned, setPinned] = createSignal<string>();
  const primary = createMemo<string | undefined>(() => {
    const pin = pinned();
    const overlaps = overlapping();
    if (pin && (overlaps.includes(pin) || overlaps.length === 0)) {
      if (itemByKey().has(pin) && !hidden().has(pin)) return pin;
    }
    return overlaps[0];
  });
  // A cursor moved elsewhere unpins a thread it no longer touches.
  createEffect(
    on(overlapping, (overlaps) => {
      const pin = pinned();
      if (pin && overlaps.length > 0 && !overlaps.includes(pin)) setPinned(undefined);
    }, { defer: true })
  );

  const [hovered, setHovered] = createSignal<string>();
  const itemByKey = createMemo(() => new Map(allItems().map((i) => [i.key, i])));

  createEffect(() => {
    const handle = focusHandle();
    if (!handle) return;
    const key = hovered() ?? primary();
    const refs = key ? (itemByKey().get(key)?.thread.refs ?? []) : [];
    const current = Object.keys(handle.doc()?.highlight ?? {});
    if (sameList([...refs].sort(), [...current].sort())) return;
    handle.change((doc) => {
      const next: Record<AutomergeUrl, true> = {};
      for (const ref of refs) next[ref] = true;
      doc.highlight = next;
    });
  });
  onCleanup(() => focusHandle()?.change((doc) => void (doc.highlight = {})));

  const select = (refs: AutomergeUrl[]) => {
    const handle = focusHandle();
    if (!handle) return;
    handle.change((doc) => {
      const next: Record<AutomergeUrl, true> = {};
      for (const ref of refs) next[ref] = true;
      doc.selection = next;
    });
  };

  // Show a thread: open its document if it isn't, then point the tools at it.
  const [revealing, setRevealing] = createSignal<Item>();
  const reveal = async (item: Item) => {
    const wasPrimary = primary() === item.key;
    setPinned(wasPrimary ? undefined : item.key);
    if (wasPrimary) return select([]);
    const c = context();
    if (c && !c.openDocs.includes(item.docUrl)) {
      // Opening takes where it is in the project, so find that first.
      const segments =
        c.root === "document" ? [] : await findSegments(repo, c.projectUrl, item.docUrl);
      if (!segments) return console.warn("comments: couldn't find that document in the project");
      setRevealing(item);
      element.dispatchEvent(
        new CustomEvent("patchwork:open-document", {
          detail: { url: locationUrl(c.projectId, segments) },
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    select(item.thread.refs);
  };
  // Once a document opened to reveal a thread is open, give its tool a moment
  // to mount and say what it has selected, then select the thread's target.
  createEffect(() => {
    const item = revealing();
    if (!item || !openDocs().includes(item.docUrl)) return;
    const timer = setTimeout(() => {
      setRevealing(undefined);
      select(item.thread.refs);
    }, 400);
    onCleanup(() => clearTimeout(timer));
  });

  const onCardClick = (event: MouseEvent, item: Item) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("textarea, button, input, a, select, .cm-editor")) return;
    void reveal(item);
  };

  // A tool asked to show a thread (one it just started, or one clicked on).
  createEffect(
    on(
      () => context()?.active?.count,
      () => {
        const active = context()?.active;
        if (!active) return;
        setPinned(active.threadUrl);
      },
      { defer: true }
    )
  );

  const state = (key: string) =>
    primary() === key ? "primary" : overlapping().includes(key) ? "secondary" : "inactive";

  // ---------------------------------------------------------------- view
  const names = () => ({ ours: context()?.ours ?? "", theirs: context()?.theirs ?? "" });

  return (
    <div class="gc-sidebar" classList={{ "gc-sidebar--framed": framed() }}>
      <div class="gc-head" hidden={framed()}>
        <span class="gc-title">Comments</span>
        <label class="gc-filter">
          <span class="gc-visually-hidden">Show comments on</span>
          <select
            value={scope()}
            onChange={(e) => setScope(e.currentTarget.value === "view" ? "view" : "project")}
          >
            <option value="project">All files</option>
            <option value="view">Open files</option>
          </select>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </label>
      </div>

      <div class="gc-list">
        <Show
          when={groups().some((g) => visibleCount(g) > 0)}
          fallback={
            <div class="gc-empty">
              {scope() === "view" ? "No comments on the open files" : "No comments yet"}
            </div>
          }
        >
          <For each={groupKeys()}>
            {(docUrl) => (
              <Show when={groupByDoc().get(docUrl)}>
                {(group) => (
                  <section class="gc-group" hidden={visibleCount(group()) === 0}>
                    <header class="gc-group-head">
                      <span class="gc-group-name">{titleOf(repo, docUrl)() ?? "Untitled"}</span>
                    </header>
                    <For each={group().items.map((i) => i.key)}>
                      {(key) => (
                        <Show when={itemByKey().get(key)}>
                          {(item) => (
                            <div
                              class="gc-card"
                              data-state={state(key)}
                              data-draft={item().draft}
                              hidden={hidden().has(key)}
                              onClick={(e) => onCardClick(e, item())}
                              onMouseEnter={() => setHovered(key)}
                              onMouseLeave={() => setHovered((k) => (k === key ? undefined : k))}
                            >
                              <RefChip
                                repo={repo}
                                refs={item().thread.refs}
                                docUrl={docUrl}
                                compact
                                onDescribed={(d) => report(key, d)}
                                draft={
                                  comparing()
                                    ? { side: item().draft, name: names()[item().draft] }
                                    : undefined
                                }
                              />
                              {/* every thread reads the same; only the selected one
                                  offers its actions (see data-thread-state) */}
                              <Show
                                when={item().threadUrl}
                                fallback={
                                  <TheirThread thread={item().thread} repo={repo} draft={names().theirs} />
                                }
                              >
                                {(url) => (
                                  <patchwork-view
                                    doc-url={url()}
                                    tool-id="comment-thread"
                                    attr:data-thread-state={state(key)}
                                  />
                                )}
                              </Show>
                            </div>
                          )}
                        </Show>
                      )}
                    </For>
                  </section>
                )}
              </Show>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/**
 * What a thread is about: the ref view's preview and line, or a quote, or
 * "Whole document", with the document's title, and which draft it's from.
 */
function RefChip(props: {
  repo: Repo;
  refs: AutomergeUrl[];
  docUrl: AutomergeUrl;
  compact?: boolean;
  draft?: { side: "ours" | "theirs"; name: string };
  onDescribed(described: Described): void;
}) {
  const [described, setDescribed] = createSignal<Described>();
  const title = titleOf(props.repo, props.docUrl);
  const key = createMemo(() => props.refs.join(" "));

  createEffect(
    on(key, () => {
      const refs = props.refs;
      let run = 0;
      let off = () => {};
      let cancelled = false;
      const describe = () => {
        const mine = ++run;
        void describeRefs(props.repo, refs).then((d) => {
          if (cancelled || mine !== run) return;
          setDescribed(d);
          props.onDescribed(d);
        });
      };
      describe();
      // Describe again as the document changes: a node renamed, text deleted.
      void props.repo
        .find(docUrlOf(props.docUrl))
        .then((handle) => {
          if (cancelled) return;
          const again = () => queueMicrotask(describe);
          handle.on("change", again);
          off = () => handle.off("change", again);
        })
        .catch(() => {});
      onCleanup(() => {
        cancelled = true;
        off();
      });
    })
  );

  const [thumb, setThumb] = createSignal<HTMLElement>();
  createEffect(() => {
    const d = described();
    const el = thumb();
    if (!d?.view?.thumbnail || !d.doc || !el || d.removed) return;
    el.replaceChildren();
    try {
      const stop = d.view.thumbnail(d.refs, d.doc, el);
      onCleanup(() => {
        stop?.();
        el.replaceChildren();
      });
    } catch (error) {
      console.error("comments: ref view failed to draw", error);
    }
  });

  const whole = () => props.refs.every(isWholeDocument);
  const isQuote = () => described()?.label.startsWith("“") ?? false;

  return (
    <div
      class="gc-chip"
      classList={{ "gc-chip--compact": !!props.compact }}
      data-removed={described()?.removed ? "" : undefined}
    >
      <Show
        when={described()?.view?.thumbnail && !described()?.removed}
        fallback={
          <Show when={whole()} fallback={<span class="gc-chip-bar" data-quote={isQuote() ? "" : undefined} />}>
            <svg class="gc-chip-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
          </Show>
        }
      >
        <span class="gc-chip-thumb" ref={setThumb} />
      </Show>
      <span class="gc-chip-text">
        <Show when={described()?.label !== ""}>
          <span class="gc-chip-label" classList={{ "gc-chip-label--quote": isQuote() }}>
            {described()?.label ?? "…"}
          </span>
        </Show>
        <Show when={!props.compact}>
          <span class="gc-chip-doc">{title() ?? ""}</span>
        </Show>
      </span>
      <Show when={props.draft}>
        {(draft) => (
          <span class="gc-draft" data-draft={draft().side}>
            {draft().name}
          </span>
        )}
      </Show>
    </div>
  );
}

type ContactDoc = { type: "anonymous" } | { type: "registered"; name: string };

/** The compared draft's thread: read only, it's a copy of that draft's. */
function TheirThread(props: { thread: CommentThread; repo: Repo; draft: string }) {
  const saved = () => props.thread.comments.filter((c) => c.content);
  return (
    <div class="comments-thread-card comments-thread-card--inactive gc-theirs">
      <div class="comments-thread-card-body">
        <For each={saved()}>
          {(comment) => {
            const [contact] = useDocument<ContactDoc>(() => comment.contactUrl, { repo: props.repo });
            return (
              <div class="comment-card">
                <div class="comment-header">
                  <div class="comment-author">
                    <patchwork-view doc-url={comment.contactUrl} tool-id="contact-avatar" />
                    <span class="comment-author-name">
                      {contact()?.type === "registered" ? (contact() as { name: string }).name : "Anonymous"}
                    </span>
                  </div>
                  <span class="comment-timestamp">{relativeTime(comment.timestamp)}</span>
                </div>
                <div class="comment-content">
                  <CuteText text={() => comment.content ?? ""} />
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <p class="gc-theirs-note">Check out {props.draft} to reply or resolve.</p>
    </div>
  );
}

function sameList<T>(a: readonly T[], b: readonly T[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

