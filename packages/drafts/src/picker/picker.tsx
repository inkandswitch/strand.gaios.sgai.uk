import type { AutomergeUrl } from "@automerge/automerge-repo/slim";
import {
  request,
  subscribe,
  type JSONValue,
  type Selector,
} from "@inkandswitch/patchwork-providers";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type Accessor,
} from "solid-js";
import { render } from "solid-js/web";

import type { DraftList, DraftSelection } from "../draft-types.js";
import { treeLines, type Cell } from "./tree-lines.js";
import "./picker.css";

/**
 * One row of the picker. Main's `url` is null, as it is in a selection, and
 * so is the `parent` of a draft forked off main.
 */
export type Entry = {
  url: AutomergeUrl | null;
  name: string;
  depth: number;
  parent: AutomergeUrl | null;
  parentName: string | null;
  childCount: number;
};

type Menu = { entry: Entry; x: number; y: number };

const MAIN = "Main";

// Picks the draft the nearest draft provider has checked out, and forks,
// merges, renames and deletes drafts through it. A component with no
// document: everything comes from the provider above it.
export function renderDraftPicker(element: HTMLElement): () => void {
  return render(() => <DraftPicker element={element} />, element);
}

function DraftPicker(props: { element: HTMLElement }) {
  const list = useSubscription<DraftList>(props.element, { type: "draft:list" });
  const selection = useSubscription<DraftSelection>(props.element, {
    type: "draft:selection",
  });
  const entries = createMemo(() => draftEntries(list()));
  const checkedOut = () => selection()?.checkedOut ?? null;
  const current = createMemo(
    () => entries().find((entry) => entry.url === checkedOut()) ?? entries()[0]
  );
  const lines = createMemo(() => treeLines(entries(), checkedOut()));

  const [dropdown, setDropdown] = createSignal<{ x: number; y: number }>();
  const [menu, setMenu] = createSignal<Menu>();
  const [renaming, setRenaming] = createSignal<Entry>();
  let button!: HTMLButtonElement;

  const close = () => {
    setDropdown(undefined);
    setMenu(undefined);
    setRenaming(undefined);
  };
  useDismiss(props.element, close);

  const send = (selector: Selector) => {
    void request(props.element, selector);
  };
  const actions = {
    select(entry: Entry) {
      close();
      send({ type: "draft:select", checkedOut: entry.url, at: null });
    },
    fork(entry: Entry) {
      close();
      send({ type: "draft:fork", parent: entry.url });
    },
    merge(entry: Entry) {
      close();
      if (!entry.url) return;
      const into = entry.parentName ?? MAIN;
      if (!window.confirm(`Merge “${entry.name}” into “${into}”?`)) return;
      send({ type: "draft:merge", draft: entry.url });
    },
    rename(entry: Entry) {
      setMenu(undefined);
      openDropdown();
      setRenaming(entry);
    },
    commitRename(entry: Entry, name: string) {
      setRenaming(undefined);
      if (name.trim() === entry.name) return;
      send({ type: "draft:rename", draft: entry.url, name });
    },
    remove(entry: Entry) {
      close();
      if (!entry.url) return;
      const warning = entry.childCount
        ? `Delete “${entry.name}” and the drafts made from it? This can't be undone.`
        : `Delete “${entry.name}”? This can't be undone.`;
      if (!window.confirm(warning)) return;
      send({ type: "draft:delete", draft: entry.url });
    },
  };

  function openDropdown() {
    const rect = button.getBoundingClientRect();
    setDropdown({ x: rect.left, y: rect.bottom + 4 });
  }

  function openMenu(entry: Entry, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    setRenaming(undefined);
    setMenu({ entry, x: event.clientX, y: event.clientY });
  }

  return (
    <div class="draft-picker">
      <button
        ref={button}
        type="button"
        class="draft-picker__button"
        aria-haspopup="menu"
        aria-expanded={!!dropdown()}
        title="Drafts"
        onClick={() => (dropdown() ? close() : openDropdown())}
        onContextMenu={(event) => {
          const entry = current();
          if (entry) openMenu(entry, event);
        }}>
        <span class="draft-picker__label">{current()?.name ?? MAIN}</span>
        <CaretIcon />
      </button>

      <Show when={dropdown()}>
        {(at) => (
          <div
            class="draft-picker__popover"
            role="menu"
            style={{ left: `${at().x}px`, top: `${at().y}px` }}>
            <ul class="draft-picker__list">
              <For each={entries()}>
                {(entry, index) => (
                  <li
                    class="draft-picker__row"
                    classList={{ "draft-picker__row--current": entry.url === checkedOut() }}
                    onContextMenu={(event) => openMenu(entry, event)}>
                    <TreeLines cells={lines()[index()] ?? []} />
                    <Show
                      when={renaming()?.url === entry.url}
                      fallback={
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={entry.url === checkedOut()}
                          class="draft-picker__entry"
                          onClick={() => actions.select(entry)}>
                          <span class="draft-picker__name">{entry.name}</span>
                        </button>
                      }>
                      <RenameInput
                        value={entry.name}
                        commit={(name) => actions.commitRename(entry, name)}
                        cancel={() => setRenaming(undefined)}
                      />
                    </Show>
                    <button
                      type="button"
                      class="draft-picker__more"
                      aria-label={`More for ${entry.name}`}
                      onClick={(event) => openMenu(entry, event)}>
                      ⋯
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <button
              type="button"
              role="menuitem"
              class="draft-picker__new"
              onClick={() => {
                const entry = current();
                if (entry) actions.fork(entry);
              }}>
              New draft from {current()?.name ?? MAIN}
            </button>
          </div>
        )}
      </Show>

      <Show when={menu()}>
        {(open) => <EntryMenu menu={open()} actions={actions} />}
      </Show>
    </div>
  );
}

function EntryMenu(props: {
  menu: Menu;
  actions: {
    fork(entry: Entry): void;
    merge(entry: Entry): void;
    rename(entry: Entry): void;
    remove(entry: Entry): void;
  };
}) {
  const entry = () => props.menu.entry;
  const isMain = () => entry().url === null;
  return (
    <div
      class="draft-picker__popover draft-picker__menu"
      role="menu"
      style={{ left: `${props.menu.x}px`, top: `${props.menu.y}px` }}>
      <button
        type="button"
        role="menuitem"
        onClick={() => props.actions.fork(entry())}>
        New draft from here
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={isMain()}
        onClick={() => props.actions.merge(entry())}>
        Merge into {entry().parentName ?? MAIN}
      </button>
      <hr />
      <button
        type="button"
        role="menuitem"
        onClick={() => props.actions.rename(entry())}>
        Rename…
      </button>
      <button
        type="button"
        role="menuitem"
        class="draft-picker__danger"
        disabled={isMain()}
        onClick={() => props.actions.remove(entry())}>
        Delete
      </button>
    </div>
  );
}

function TreeLines(props: { cells: Cell[] }) {
  return (
    <For each={props.cells}>
      {(cell) => (
        <span class="draft-tree__cell" aria-hidden="true">
          <Show when={cell.up !== "none"}>
            <span class={`draft-tree__up draft-tree--${cell.up}`} />
          </Show>
          <Show when={cell.down !== "none"}>
            <span class={`draft-tree__down draft-tree--${cell.down}`} />
          </Show>
          <Show when={cell.tick !== "none"}>
            <span class={`draft-tree__tick draft-tree--${cell.tick}`} />
          </Show>
        </span>
      )}
    </For>
  );
}

function RenameInput(props: {
  value: string;
  commit(name: string): void;
  cancel(): void;
}) {
  let input!: HTMLInputElement;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) props.commit(input.value);
    else props.cancel();
  };
  onMount(() => {
    input.focus();
    input.select();
  });
  return (
    <input
      ref={input}
      class="draft-picker__rename"
      value={props.value}
      aria-label="Draft name"
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") {
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** Main, then every draft beneath the one it was forked off. */
export function draftEntries(list: DraftList | undefined): Entry[] {
  const mainName = list?.main.name ?? MAIN;
  const main: Entry = {
    url: null,
    name: mainName,
    depth: 0,
    parent: null,
    parentName: null,
    childCount: list?.main.childCount ?? 0,
  };
  if (!list) return [main];
  const byUrl = new Map(list.drafts.map((draft) => [draft.url, draft]));
  const depthOf = (parent: AutomergeUrl | null) => {
    const seen = new Set<AutomergeUrl>();
    let depth = 1;
    while (parent && byUrl.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth++;
      parent = byUrl.get(parent)!.parent;
    }
    return depth;
  };
  return [
    main,
    ...list.drafts.map((draft) => {
      const parent = draft.parent ? byUrl.get(draft.parent) : undefined;
      return {
        url: draft.url,
        name: draft.name ?? "Draft",
        depth: depthOf(draft.parent),
        parent: parent ? parent.url : null,
        parentName: parent ? (parent.name ?? "Draft") : mainName,
        childCount: draft.childCount,
      };
    }),
  ];
}

function useSubscription<T extends JSONValue>(
  element: HTMLElement,
  selector: Selector
): Accessor<T | undefined> {
  const [value, setValue] = createSignal<T>();
  onCleanup(subscribe<T>(element, selector, (next) => setValue(() => next)));
  return value;
}

// Close on a press outside the picker, on Escape, and when the window loses
// focus or resizes away from where the popovers were placed.
function useDismiss(element: HTMLElement, close: () => void) {
  const onPointerDown = (event: PointerEvent) => {
    if (!event.composedPath().includes(element)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
  });
}

function CaretIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="currentColor"
      aria-hidden="true">
      <path d="M0.5 2h7L4 6.5z" />
    </svg>
  );
}
