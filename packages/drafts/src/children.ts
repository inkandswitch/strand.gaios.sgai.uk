import {
  encodeHeads,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import {
  getRegistry,
  type Plugin,
  type PluginDescription,
} from "@inkandswitch/patchwork-plugins";

import type { Member } from "./overlay-types.js";

export const CHILDREN_PLUGIN_TYPE = "patchwork:children";

// Registered by whichever package knows a datatype's shape. `"*"` answers for
// every datatype.
export type ChildrenDescription = PluginDescription & {
  type: typeof CHILDREN_PLUGIN_TYPE;
  datatypes: string[];
};

// What the plugin loads: the documents that are part of `doc`. Only ones that
// belong to it, never ones it merely refers to (authors, accounts, tools).
export type ChildrenOf = (doc: unknown) => AutomergeUrl[];

// How the walk reads a member: through an overlay, so it sees the overlay's
// version of each one.
export type Open = (url: AutomergeUrl) => Promise<DocHandle<unknown>>;

export type DocTree = {
  // root first, then depth-first in entry order
  urls: () => AutomergeUrl[];
  has: (url: AutomergeUrl) => boolean;
  members: () => Member[];
  // Resolves once the first walk has finished.
  settled: () => Promise<void>;
  isSettled: () => boolean;
  refresh: () => void;
  dispose: () => void;
};

const REBUILD_DEBOUNCE_MS = 50;

// Every member under `root`. The first path to a member wins, so each appears
// once, and cycles end there. Members that fail to load are leaves. Every
// member is watched, and any change to one (or a children plugin registering)
// walks again; `onChange` hears when the members or their heads moved.
export function watchDocTree(
  root: AutomergeUrl,
  open: Open,
  onChange?: () => void
): DocTree {
  let members: Member[] = [];
  let urls = new Set<AutomergeUrl>();
  const watched = new Map<AutomergeUrl, DocHandle<unknown>>();
  let disposed = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let building = false;
  let pending = false;
  let resolveSettled!: () => void;
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const onWatchedChange = () => schedule();
  const offRegistry = childrenRegistry().on("changed", schedule);
  schedule();

  return {
    urls: () => members.map((member) => member.url),
    has: (url) => urls.has(canonicalUrl(url)),
    members: () => members,
    settled: () => settledPromise,
    isSettled: () => settled,
    refresh: schedule,
    dispose() {
      disposed = true;
      offRegistry();
      if (timer !== null) clearTimeout(timer);
      for (const handle of watched.values()) handle.off("change", onWatchedChange);
      watched.clear();
      resolveSettled();
    },
  };

  function schedule(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void rebuild();
    }, REBUILD_DEBOUNCE_MS);
  }

  async function rebuild(): Promise<void> {
    if (disposed) return;
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      const next = await walkDocTree(canonicalUrl(root), open);
      if (disposed) return;
      const changed = !sameMembers(members, next.members);
      members = next.members;
      urls = new Set(next.members.map((member) => member.url));
      rewatch(next.read);
      settled = true;
      if (changed) onChange?.();
    } catch (err) {
      console.error("[drafts] member walk failed:", err);
    } finally {
      building = false;
      resolveSettled();
      if (pending) {
        pending = false;
        schedule();
      }
    }
  }

  function rewatch(read: Map<AutomergeUrl, DocHandle<unknown>>): void {
    for (const [url, handle] of watched) {
      if (read.get(url) === handle) continue;
      handle.off("change", onWatchedChange);
      watched.delete(url);
    }
    for (const [url, handle] of read) {
      if (watched.has(url)) continue;
      handle.on("change", onWatchedChange);
      watched.set(url, handle);
    }
  }
}

// One walk of the members under `root`. Children load in parallel; the order
// stays depth-first in entry order, so the first path is deterministic.
export async function walkDocTree(
  root: AutomergeUrl,
  open: Open
): Promise<{
  members: Member[];
  read: Map<AutomergeUrl, DocHandle<unknown>>;
}> {
  const members: Member[] = [];
  const read = new Map<AutomergeUrl, DocHandle<unknown>>();
  const visited = new Set<AutomergeUrl>([root]);
  const loads = new Map<AutomergeUrl, Promise<DocHandle<unknown> | null>>();

  const load = (url: AutomergeUrl) => {
    let promise = loads.get(url);
    if (!promise) {
      promise = open(url).then(
        (handle) => {
          read.set(url, handle);
          return handle;
        },
        () => null
      );
      loads.set(url, promise);
    }
    return promise;
  };

  const visit = async (url: AutomergeUrl, parent: AutomergeUrl | null) => {
    const handle = await load(url);
    members.push({ url, heads: handle ? headsOf(handle) : encodeHeads([]), parent });
    if (!handle) return;
    const children = (await childrenOf(handle.doc())).filter(
      (child) => !visited.has(child)
    );
    for (const child of children) {
      visited.add(child);
      void load(child);
    }
    for (const child of children) await visit(child, url);
  };

  await visit(root, null);
  return { members, read };
}

// The children of a document, from every children plugin for its datatype and
// every `"*"` one.
export async function childrenOf(doc: unknown): Promise<AutomergeUrl[]> {
  const type = datatypeOf(doc);
  const registry = childrenRegistry();
  const plugins = registry.filter((plugin) => answersFor(plugin, type));
  const loaded = await registry.loadAll(plugins);
  const out: AutomergeUrl[] = [];
  const seen = new Set<AutomergeUrl>();
  for (const plugin of loaded) {
    let links: unknown[];
    try {
      links = (plugin.module as ChildrenOf)(doc) ?? [];
    } catch (err) {
      console.warn(`[drafts] children plugin ${plugin.id} failed:`, err);
      continue;
    }
    for (const link of links) {
      if (!isValidAutomergeUrl(link)) continue;
      const url = canonicalUrl(link);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

// A url's bare document identity, without path or heads, so urls arriving
// from different places name a member the same way.
export function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}

function headsOf(handle: DocHandle<unknown>): UrlHeads {
  try {
    return handle.heads() ?? encodeHeads([]);
  } catch {
    return encodeHeads([]);
  }
}

function childrenRegistry() {
  return getRegistry<ChildrenDescription>(CHILDREN_PLUGIN_TYPE);
}

function answersFor(plugin: Plugin<ChildrenDescription>, type: string | undefined): boolean {
  const datatypes = Array.isArray(plugin.datatypes) ? plugin.datatypes : [];
  return datatypes.includes("*") || (type !== undefined && datatypes.includes(type));
}

function datatypeOf(doc: unknown): string | undefined {
  const type = (doc as { "@patchwork"?: { type?: unknown } } | undefined)?.[
    "@patchwork"
  ]?.type;
  return type === undefined || type === null ? undefined : String(type);
}

function sameMembers(a: Member[], b: Member[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (member, i) =>
        member.url === b[i].url &&
        member.parent === b[i].parent &&
        sameHeads(member.heads, b[i].heads)
    )
  );
}

export function sameHeads(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((h) => set.has(h));
}
