import { useDocument } from "solid-automerge";
import type { AutomergeUrl, Repo } from "@automerge/automerge-repo/slim";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import {
  createEffect,
  createMemo,
  createSelector,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { render } from "solid-js/web";

import {
  setAutoExpandedFolders,
  dropError,
} from "./state.ts";
import {
  foldersToReveal,
  isMounted,
  watchFolder,
} from "./document-list/auto-expand.ts";
import CreateNew, { preloadCreateNew } from "./create-new.tsx";
import { createOpenEvent, type OpenDetail } from "./events.ts";
import { useChangeMarks } from "./document-list/changes.ts";
import { DocumentList } from "./document-list/document-list.tsx";
import { LoadingRows } from "./document-list/loading-row.tsx";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import {
  clearDropTarget,
  copyMode,
  endSpot,
  isNewDocDrag,
  setDropTarget,
} from "./dnd/dnd.ts";
import { dropInto } from "./dnd/drop-into.ts";
import { hasDocumentDrag } from "./dnd/payload.ts";
import { createMarquee } from "./document-list/marquee.ts";
import { createTreeNav } from "./document-list/tree-nav.ts";
import { FoldIcon } from "./icons.tsx";
import { menuTarget } from "./state.ts";

const ItemMenu = lazy(() =>
  import("./document-list/item-menu.tsx").then((m) => ({
    default: m.ItemMenu,
  }))
);

/**
 * The document-list panel: a scrolling, recursive list of the folder's
 * documents and subfolders, where a right-click outside the rows makes a new
 * document. Renders a single folder, given its url. Inside a compare provider, the files the
 * checked-out draft and the compared one differ on are marked, and what's
 * unchanged can be folded away.
 *
 * Documents are opened by where they sit under the folder
 * (`automerge:<folder>/<name>/<name>`) rather than by their own url.
 */
export function DocumentListPanel(props: {
  folderUrl: AutomergeUrl;
  repo: Repo;
  element: PatchworkViewElement;
}) {
  const [folder, folderHandle] = useDocument<FolderDoc>(() => props.folderUrl, {
    repo: props.repo,
  });
  const changes = useChangeMarks(props.element);

  // The row menu is split out to keep it off the initial load, but fetching it
  // on the first right-click means that click does nothing until the chunk
  // arrives (and with a slow module load, looks like it never opened). Fetch
  // it once things are idle so it's there before anyone right-clicks.
  onMount(() => {
    const preload = () => {
      void ItemMenu.preload();
      preloadCreateNew();
    };
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(preload);
      onCleanup(() => cancelIdleCallback(id));
    } else {
      const id = setTimeout(preload, 0);
      onCleanup(() => clearTimeout(id));
    }
  });

  // Optimistic loading: show the skeleton from the moment the panel mounts and
  // keep it up until the root folder handle has actually resolved. Reading the
  // resource's `.state` (rather than `folder()`) never suspends, so the box +
  // toolbar paint immediately and the skeleton is guaranteed a beat of screen
  // time instead of relying on Suspense — which is skipped entirely when the
  // handle happens to resolve synchronously.
  const folderReady = () =>
    folderHandle.state === "ready" || folderHandle.state === "refreshing";

  createEffect(() => {
    if (folderHandle.latest) watchFolder(folderHandle.latest);
  });

  const selectedDocUrls = subscribe<AutomergeUrl[]>(
    props.element,
    { type: "patchwork:selected-doc" },
    []
  );

  // A selector so a selection change only notifies the rows whose selected
  // state actually flipped, instead of every row re-scanning the array.
  const selectedSet = createMemo(() => new Set(selectedDocUrls()));
  const isSelected = createSelector(
    selectedSet,
    (url: AutomergeUrl, set) => set.has(url)
  );

  // Whenever the selection changes, work out which folders need to be open for
  // the selected docs to be visible, and publish that set. Each Folder reads it
  // to auto-expand itself; expansion cascades down as each level mounts, so
  // even a deeply nested selection gets revealed.
  //
  // A selection whose rows are already mounted is already revealed (usually it
  // was just clicked), so there's nothing to do. Otherwise foldersToReveal
  // traces it up the parent index, walking the tree only for what that misses.
  //
  // Gated on folderReady: the walk recursively finds folder docs across the
  // tree, so kicking it off before the root has loaded would flood the repo and
  // keep the whole widget blank. Let the top level paint first, then reveal.
  createEffect(() => {
    if (!folderReady()) return;
    const selected = selectedDocUrls();
    if (!selected.length) {
      setAutoExpandedFolders(new Set());
      return;
    }
    if (selected.every((url) => isMounted(props.element, url))) return;
    let cancelled = false;
    foldersToReveal(props.repo, props.folderUrl, selected).then((folders) => {
      if (!cancelled) setAutoExpandedFolders(folders);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  function open(detail: OpenDetail) {
    props.element.dispatchEvent(createOpenEvent(detail));
  }

  // cmd/ctrl-drag rubber-band multi-select over the list. Attached in the
  // capture phase because an item's own mousedown handler stops propagation for
  // cmd-clicks, which would otherwise swallow a band that starts on a row.
  let navEl: HTMLElement | undefined;
  const marquee = createMarquee({
    container: () => navEl,
    source: () => props.element.toolId ?? "",
  });
  const attachMarquee = (el: HTMLElement) => {
    navEl = el;
    el.addEventListener("mousedown", marquee.onMouseDown, true);
    onCleanup(() => el.removeEventListener("mousedown", marquee.onMouseDown, true));
    // and the keyboard: one tab stop, arrows, Home/End, Left to the parent
    onCleanup(createTreeNav(el));
  };

  // Rows open their own menu and stop the event, so a right-click that gets
  // here is past them: it makes a new document in the folder.
  const [newAt, setNewAt] = createSignal<{ x: number; y: number }>();
  function openNewMenu(event: MouseEvent) {
    if ((event.target as Element).closest("input")) return;
    event.preventDefault();
    setNewAt({ x: event.clientX, y: event.clientY });
  }

  return (
    <aside class="document-list" on:contextmenu={openNewMenu}>
      <Show when={changes.comparing()}>
        <div class="document-list__compare-bar">
          <Show when={changes.merge()}>
            {(merge) => (
              <span class="document-list__compare-kind">
                {merge().published ? "Pull request" : "Merge preview"}
              </span>
            )}
          </Show>
          <button
            type="button"
            class="document-list__collapse"
            aria-pressed={changes.collapsed()}
            title={changes.collapsed() ? "Show unchanged" : "Collapse unchanged"}
            onClick={() => changes.toggleCollapsed()}
          >
            <FoldIcon />
          </button>
        </div>
      </Show>
      <nav
        ref={attachMarquee}
        class="document-list__doclist document-list-widget"
        role="tree"
        aria-multiselectable="true"
        data-dnd-container={props.folderUrl}
        // Rows and folders say where a drop over them goes and stop the event,
        // so a dragover that gets here is past the last row (or over the
        // toolbar): the drop goes at the end of the list, and the line says so.
        onDragOver={(event: DragEvent) => {
          const files = event.dataTransfer?.types.includes("Files");
          if (!files && !hasDocumentDrag(event.dataTransfer) && !isNewDocDrag(event)) {
            return;
          }
          event.preventDefault();
          event.dataTransfer!.dropEffect = files ? "copy" : copyMode() ? "copy" : "move";
          const h = folderHandle.latest;
          if (h) setDropTarget(endSpot(h.url, h.doc()?.docs?.length ?? 0));
        }}
        onDragLeave={(event: DragEvent) => {
          const related = event.relatedTarget as Element;
          if (!related || !(event.currentTarget as Element).contains(related)) {
            clearDropTarget();
          }
        }}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          const h = folderHandle.latest;
          if (!h) return;
          dropInto(event, {
            repo: props.repo,
            rootFolderHandle: h,
            element: props.element,
          });
        }}
      >
        <Show when={folderReady()} fallback={<LoadingRows depth={0} />}>
          <Suspense fallback={<LoadingRows depth={0} />}>
            <DocumentList
              depth={0}
              repo={props.repo}
              docs={folder()?.docs}
              handle={folderHandle.latest!}
              open={open}
              location={props.folderUrl}
              isSelected={isSelected}
              element={props.element}
              rootFolderHandle={folderHandle.latest!}
              changes={changes}
            />
          </Suspense>
          <Show when={menuTarget()}>
            <ItemMenu
              repo={props.repo}
              rootFolderHandle={folderHandle.latest!}
              element={props.element}
            />
          </Show>
        </Show>
        <Show when={dropError()?.element === props.element}>
          <p class="document-list__error" role="alert">
            {dropError()!.message}
          </p>
        </Show>
      </nav>
      <Show when={newAt()}>
        {(at) => (
          <CreateNew
            at={at()}
            onClose={() => setNewAt()}
            changeFolder={(fn) => folderHandle()?.change(fn)}
            repo={props.repo}
            open={open}
            location={props.folderUrl}
          />
        )}
      </Show>
    </aside>
  );
}

// Kept here (rather than index.tsx) so the entry point never statically
// imports solid-js/web — the doc-list tool shouldn't load Solid until it's
// actually mounted for a folder document.
export function renderDocumentListPanel(
  folderUrl: AutomergeUrl,
  element: PatchworkViewElement & { repo: Repo }
) {
  return render(
    () => (
      <DocumentListPanel folderUrl={folderUrl} repo={element.repo} element={element} />
    ),
    element
  );
}
