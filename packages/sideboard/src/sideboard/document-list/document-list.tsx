import {
  deleteAt,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import type { OpenDetail } from "../events.ts";
import type {
  DocLink,
  FolderDoc,
  HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import { getRegistry, isLoadedPlugin, type Datatype } from "@inkandswitch/patchwork-plugins";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  Match,
  onCleanup,
  Show,
  Suspense,
  Switch,
  untrack,
} from "solid-js";
import {
  setRenaming,
  pendingNewDoc,
  setPendingNewDoc,
} from "../state.ts";
import { asString, setText } from "../lib/text.ts";
import { childLocation } from "../lib/location.ts";
import { markMounted } from "./auto-expand.ts";
import type { ChangeMarks } from "./changes.ts";
import Folder from "./folder.tsx";
import { GhostRows } from "./ghost.tsx";
import Item from "./item.tsx";
import { ItemName } from "./name.tsx";
import { LoadingRow } from "./loading-row.tsx";

const NewDocPlaceholder = lazy(() =>
  import("../create-new-menu.tsx").then((m) => ({
    default: m.NewDocPlaceholder,
  }))
);

export interface DocumentListProps {
  handle: DocHandle<FolderDoc>;
  docs?: DocLink[];
  depth: number;
  repo: Repo;
  open(detail: OpenDetail): void;
  /** Where this list's folder sits: documents open by location. */
  location: string;
  isSelected(url: AutomergeUrl): boolean;
  visitedFolders?: Set<AutomergeUrl>;
  element: PatchworkViewElement;
  rootFolderHandle: DocHandle<FolderDoc>;
  changes: ChangeMarks;
}

// Rows mounted per frame-budget slice while a big folder streams in.
const CHUNK = 40;
const FRAME_BUDGET_MS = 8;

export function DocumentList(props: DocumentListProps) {
  const visitedFolders = props.visitedFolders ?? new Set<AutomergeUrl>();

  // Mount a long list incrementally: the first chunk paints right away, and
  // each animation frame mounts as many more chunks as fit in its budget, so a
  // folder with thousands of entries never freezes the page. Rows keep their
  // identity across slices (automerge preserves it for untouched objects), so
  // For doesn't re-create the ones already on screen.
  const [limit, setLimit] = createSignal(CHUNK);
  createEffect(() => {
    const total = props.docs?.length ?? 0;
    if (untrack(limit) >= total) return;
    let frame = requestAnimationFrame(function more() {
      const start = performance.now();
      let n = untrack(limit);
      do setLimit((n += CHUNK));
      while (n < total && performance.now() - start < FRAME_BUDGET_MS);
      if (n < total) frame = requestAnimationFrame(more);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const docs = createMemo(() => {
    const all = props.docs ?? [];
    return all.length > limit() ? all.slice(0, limit()) : all;
  });

  function removeItem(index: number) {
    props.handle.change((folder) => deleteAt(folder.docs, index));
  }

  // True when a "new document" drag/click targeted this folder's list.
  const pendingHere = () =>
    !!props.handle && pendingNewDoc()?.containerUrl === props.handle.url;

  // Commit the pending placeholder: insert the freshly created doc at the drop
  // index, open it, and drop straight into rename mode.
  const commitPending = (docLink: DocLink) => {
    const target = pendingNewDoc();
    if (!target) return;
    const index = target.index;
    setPendingNewDoc(null);
    props.handle.change((folder) => folder.docs.splice(index, 0, docLink));
    props.open({
      url: childLocation(props.location, docLink, props.handle.doc()?.docs),
    });
    setRenaming(props.handle.url + "/" + index);
  };

  const placeholder = () => (
    <div class="document-list__item document-list__item--visible">
      <NewDocPlaceholder
        repo={props.repo}
        onCreate={commitPending}
        onDismiss={() => setPendingNewDoc(null)}
      />
    </div>
  );

  return (
    <>
      <For each={docs()}>
        {(doc, index) => {
          const mark = () => props.changes.mark(doc.url);
          const remove = () => removeItem(index());
          const relid = () => props.handle.url + "/" + index();
          onCleanup(markMounted(props.element, doc.url));
          const rename = (name: string) => {
            props.handle.change((doc) =>
              setText(doc, ["docs", index(), "name"], name)
            );
            const datatypes = getRegistry<Datatype>("patchwork:datatype");
            props.repo
              .find<Partial<HasPatchworkMetadata>>(doc.url)
              .then(async (handle) => {
                const { "@patchwork": metadata } = handle.doc();

                if (metadata) {
                  const datatype = datatypes.get(metadata.type) as Datatype;

                  if (datatype) {
                    await datatypes.load(datatype.id);
                    const module = (datatype as any).module;
                    if (module.getTitle?.(handle.doc()) === name) return;
                    handle.change((doc) => module.setTitle?.(doc, name));
                  }
                }
              });
          };

          // A title changed inside the open document renames its entry in
          // the folder. Only a change does: opening a document writes
          // nothing, to it or to its folder.
          createEffect(() => {
            if (!props.isSelected(doc.url)) return;

            let cancelled = false;
            let removeListener: (() => void) | undefined;

            props.repo
              .find<Partial<HasPatchworkMetadata>>(doc.url)
              .then(async (docHandle) => {
                if (cancelled) return;

                const datatypes = getRegistry<Datatype>("patchwork:datatype");

                async function titleOf(): Promise<string | undefined> {
                  const docData = docHandle.doc();
                  if (!docData) return undefined;

                  const metadata = (docData as any)["@patchwork"];
                  if (!metadata?.type) return undefined;

                  const datatype = datatypes.get(metadata.type) as Datatype;
                  if (!datatype) return undefined;

                  await datatypes.load(datatype.id);
                  if (cancelled || !isLoadedPlugin(datatype)) return undefined;
                  return datatype.module.getTitle(docData) || undefined;
                }

                let seen = await titleOf();
                if (cancelled) return;

                async function syncTitle() {
                  const title = await titleOf();
                  if (cancelled || !title || title === seen) return;
                  // The first title read is where the document starts, not
                  // a change (it may not have been readable when opened).
                  const before = seen;
                  seen = title;
                  if (before === undefined) return;
                  // Compare by value: pushwork stores names as
                  // ImmutableStrings, which never === a plain string.
                  const currentName = props.handle.doc()?.docs?.[index()]?.name;
                  if (asString(currentName) !== title) {
                    props.handle.change((folder) =>
                      setText(folder, ["docs", index(), "name"], title)
                    );
                  }
                }

                const onChange = () => void syncTitle();
                docHandle.on("change", onChange);
                removeListener = () => docHandle.off("change", onChange);
              });

            onCleanup(() => {
              cancelled = true;
              removeListener?.();
            });
          });

          return (
            <>
              <Show when={pendingHere() && pendingNewDoc()!.index === index()}>
                {placeholder()}
              </Show>
              <div
                class="document-list__item"
                classList={{
                  "document-list__item--folded": props.changes.collapsed() && !mark(),
                }}
              >
                {/* Per-row boundary: a folder still loading its handle shows a
                    skeleton here without blocking its siblings. */}
                <Suspense fallback={<LoadingRow depth={props.depth} />}>
                <Switch>
                <Match when={doc.type == "folder"}>
                  <Show
                    when={!visitedFolders.has(doc.url)}
                    fallback={
                      <div
                        class="document-list-folder__circular-ref"
                        style={{ "padding-left": `calc(var(--depth) * 1rem)` }}
                      >
                        <span>{doc.name} (i contain myself eventually)</span>
                      </div>
                    }
                  >
                    <Folder
                      url={doc.url}
                      depth={props.depth}
                      repo={props.repo}
                      removeFromParent={remove}
                      parentFolderHandle={props.handle}
                      itemIndex={index()}
                      open={props.open}
                      location={childLocation(props.location, doc, props.docs)}
                      name={doc.name}
                      isSelected={props.isSelected}
                      visitedFolders={visitedFolders}
                      element={props.element}
                      rootFolderHandle={props.rootFolderHandle}
                      changes={props.changes}
                    />
                  </Show>
                </Match>
                <Match when={doc.type != "folder"}>
                  <Item
                    aria-label={doc.name}
                    url={doc.url}
                    name={doc.name}
                    id={relid()}
                    startRenaming={() => setRenaming(relid())}
                    remove={remove}
                    pressed={props.isSelected(doc.url)}
                    mark={mark()}
                    unchanged={props.changes.comparing() && !mark()}
                    type={doc.type}
                    element={props.element}
                    repo={props.repo}
                    rootFolderHandle={props.rootFolderHandle}
                    parentFolderHandle={props.handle}
                    itemIndex={index()}
                    location={childLocation(props.location, doc, props.docs)}
                    openWith={(toolId, placement) =>
                      props.open({
                        url: childLocation(props.location, doc, props.docs),
                        toolId,
                        placement,
                      })
                    }
                  >
                    <ItemName name={doc.name} id={relid()} rename={rename} />
                  </Item>
                </Match>
                </Switch>
                </Suspense>
              </div>
            </>
          );
        }}
      </For>
      <GhostRows parent={props.handle.url} depth={props.depth} changes={props.changes} />
      <Show
        when={pendingHere() && pendingNewDoc()!.index >= (props.docs?.length ?? 0)}
      >
        {placeholder()}
      </Show>
  </>
  );
}
