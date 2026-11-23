import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { getRegistry, type DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { openThreads, type CommentThread, type DocWithComments } from "./comments";

export type DocThreads = {
  handle: DocHandle<DocWithComments>;
  threads: CommentThread[];
};

/**
 * The open threads on each of `urls`, kept current as the documents change
 * and as urls come and go. Only the documents that are found are listed.
 */
export function useThreadsOf(
  repo: Repo,
  urls: Accessor<AutomergeUrl[]>
): Accessor<Map<AutomergeUrl, DocThreads>> {
  const [all, setAll] = createSignal(new Map<AutomergeUrl, DocThreads>());
  const watching = new Map<AutomergeUrl, () => void>();

  const set = (url: AutomergeUrl, value: DocThreads | undefined) =>
    setAll((previous) => {
      const next = new Map(previous);
      if (value) next.set(url, value);
      else next.delete(url);
      return next;
    });

  createEffect(() => {
    const wanted = new Set(urls());
    for (const [url, stop] of watching) {
      if (wanted.has(url)) continue;
      stop();
      watching.delete(url);
      set(url, undefined);
    }
    for (const url of wanted) {
      if (watching.has(url)) continue;
      let stopped = false;
      let off = () => {};
      watching.set(url, () => {
        stopped = true;
        off();
      });
      repo
        .find<DocWithComments>(url)
        .then((handle) => {
          if (stopped) return;
          const read = () => set(url, { handle, threads: openThreads(handle.doc()) });
          read();
          handle.on("change", read);
          off = () => handle.off("change", read);
        })
        .catch(() => {});
    }
  });
  onCleanup(() => {
    for (const stop of watching.values()) stop();
    watching.clear();
  });
  return all;
}

type Overlay = AutomergeUrl | null;
// Only which two versions are read here, whichever kind of comparison it is.
type Comparison = { kind: "compare" | "merge"; a: Overlay; b: Overlay } | null;
type OverlaysState = { checkedOut: Overlay };
// The repo views read through: an overlay's, which reads other overlays too.
type OverlayRepo = { findIn?(overlay: Overlay, url: AutomergeUrl): Promise<DocHandle<DocWithComments>> };

/**
 * While two versions are compared: the open threads the other version's copy
 * of each of `urls` has. Shown, but not changed from here.
 */
export function useTheirThreads(
  element: HTMLElement & { repo?: unknown },
  urls: Accessor<AutomergeUrl[]>,
  comparing: Accessor<boolean>
): Accessor<Map<AutomergeUrl, CommentThread[]>> {
  const [all, setAll] = createSignal(new Map<AutomergeUrl, CommentThread[]>());
  // The other version: B, or A from inside B.
  const [other, setOther] = createSignal<{ overlay: Overlay } | undefined>(undefined, {
    equals: (a, b) => a?.overlay === b?.overlay,
  });
  createEffect(() => {
    if (!comparing()) {
      setOther(undefined);
      return;
    }
    let comparison: Comparison | undefined;
    let overlays: OverlaysState | undefined;
    const work = () =>
      setOther(
        comparison && overlays
          ? { overlay: overlays.checkedOut === comparison.a ? comparison.b : comparison.a }
          : undefined
      );
    onCleanup(
      subscribe<never>(element, { type: "compare" } as never, (value) => {
        comparison = value as Comparison;
        work();
      })
    );
    onCleanup(
      subscribe<never>(element, { type: "overlays" } as never, (value) => {
        overlays = value as OverlaysState;
        work();
      })
    );
  });
  createEffect(() => {
    const current = other();
    const list = urls();
    setAll(new Map());
    const repo = element.repo as OverlayRepo | undefined;
    if (!current || !repo?.findIn) return;
    const stops: (() => void)[] = [];
    let live = true;
    for (const url of list) {
      repo.findIn(current.overlay, url).then(
        (handle) => {
          if (!live) return;
          const read = () =>
            setAll((previous) =>
              new Map(previous).set(url, structuredClone(openThreads(handle.doc())))
            );
          read();
          handle.on("change", read);
          stops.push(() => handle.off("change", read));
        },
        (error) => console.error("comments: couldn't read the other version's copy", error)
      );
    }
    onCleanup(() => {
      live = false;
      for (const stop of stops) stop();
    });
  });
  return all;
}

/**
 * Where `target` sits in the project: the names of the folder entries leading
 * to it from `root`, breadth first, so the shallowest copy wins. Undefined
 * when it isn't in there.
 */
export async function findSegments(
  repo: Repo,
  root: AutomergeUrl,
  target: AutomergeUrl
): Promise<string[] | undefined> {
  const seen = new Set<AutomergeUrl>([root]);
  let level: { url: AutomergeUrl; segments: string[] }[] = [{ url: root, segments: [] }];
  for (let depth = 0; depth < 12 && level.length > 0; depth++) {
    const next: typeof level = [];
    const folders = await Promise.all(
      level.map(async (at) => ({ at, handle: await repo.find<FolderDoc>(at.url).catch(() => undefined) }))
    );
    for (const { at, handle } of folders) {
      for (const link of handle?.doc()?.docs ?? []) {
        const segments = [...at.segments, link.name];
        if (link.url === target) return segments;
        if (link.type === "folder" && !seen.has(link.url)) {
          seen.add(link.url);
          next.push({ url: link.url, segments });
        }
      }
    }
    level = next;
  }
  return undefined;
}

const titles = new Map<AutomergeUrl, Accessor<string | undefined>>();

/** A document's title, as its datatype names it. */
export function titleOf(repo: Repo, url: AutomergeUrl): Accessor<string | undefined> {
  const known = titles.get(url);
  if (known) return known;
  const [title, setTitle] = createSignal<string>();
  titles.set(url, title);
  void (async () => {
    const handle = await repo.find<Record<string, unknown>>(url).catch(() => undefined);
    if (!handle) return;
    const type = (handle.doc()?.["@patchwork"] as { type?: string } | undefined)?.type;
    const registry = getRegistry("patchwork:datatype");
    const datatype = type
      ? ((await registry.load(type).catch(() => undefined))?.module as
          | DatatypeImplementation<unknown>
          | undefined)
      : undefined;
    const read = () => {
      const doc = handle.doc();
      if (!doc) return;
      try {
        setTitle(datatype?.getTitle?.(doc) ?? (doc.title as string | undefined) ?? (doc.name as string | undefined));
      } catch {
        setTitle(undefined);
      }
    };
    read();
    handle.on("change", read);
  })();
  return title;
}

/** Resolve urls to handles; lags a tick behind `urls`. */
export function useResolved(
  repo: Repo,
  urls: Accessor<AutomergeUrl[]>
): Accessor<DocHandle<unknown>[]> {
  const [handles, setHandles] = createSignal<DocHandle<unknown>[]>([]);
  createEffect(() => {
    const list = urls();
    let cancelled = false;
    Promise.all(list.map((u) => repo.find(u).catch(() => undefined))).then((found) => {
      if (!cancelled) setHandles(found.filter((h): h is DocHandle<unknown> => Boolean(h)));
    });
    onCleanup(() => {
      cancelled = true;
    });
  });
  return handles;
}
