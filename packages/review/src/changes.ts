import {
  isImmutableString,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";
import { diffLines } from "diff";

// The parts of the drafts package's stored shapes read here. A draft records
// a `CloneEntry` per doc it forked; `cloneUrl` is set once it has written to
// the doc, and the clone shares the original's history, so `clonedAt` names
// the fork point in it. A doc the draft created is its own clone, forked at
// nothing.
export type CloneEntry = { clonedAt: UrlHeads; cloneUrl?: AutomergeUrl };
export type DraftDoc = { clones?: Record<AutomergeUrl, CloneEntry> };

export type FileChange = Place & {
  url: AutomergeUrl;
  status: "added" | "deleted" | "modified";
  // Lines, or null when it isn't text, or was too big to diff in time.
  added: number | null;
  removed: number | null;
};

export type DraftReview = {
  changes: FileChange[];
  // The docs a change to which can change the review.
  watched: DocHandle<unknown>[];
};

// Line counts already worked out, by the versions they compare.
export type CountCache = Map<string, Counts | null>;
type Counts = { added: number; removed: number };

// Where a doc is in the tree: its path by name, and its location, which is
// what the project frame opens documents by: `automerge:<root>/<segment>/...`,
// each segment an entry's name, or its document id when the name is empty or
// a sibling's too.
type Place = { path: string; location: AutomergeUrl };
type Link = { url: AutomergeUrl; name: string; folder: boolean };
type Node = Place & { folder: DocHandle<unknown> | null };
type Tree = Map<AutomergeUrl, Node>;

const DIFF_TIMEOUT_MS = 1500;

/**
 * Every file the draft changed under `rootUrl`, against where it forked off,
 * by path. `repo` reads through the draft, so the tree and the files are the
 * draft's. A file taken out of the tree is reported by the folder it was in.
 */
export async function reviewDraft(
  repo: Repo,
  rootUrl: AutomergeUrl,
  draft: DraftDoc,
  cache: CountCache = new Map()
): Promise<DraftReview> {
  const tree = await walkTree(repo, canonical(rootUrl));
  const changes = new Map<AutomergeUrl, FileChange>();
  const watched: DocHandle<unknown>[] = [...tree.values()].flatMap((node) =>
    node.folder ? [node.folder] : []
  );
  const add = (change: FileChange | null) => {
    if (change && !changes.has(change.url)) changes.set(change.url, change);
  };

  const forked = Object.entries(draft.clones ?? {}) as [AutomergeUrl, CloneEntry][];
  await Promise.all(
    forked.map(async ([url, entry]) => {
      const node = tree.get(url);
      if (!entry.cloneUrl || !node) return;
      const before = await atFork(repo, entry);
      if (node.folder) {
        for (const change of await folderChanges(repo, tree, node, before, cache)) {
          add(change);
        }
        return;
      }
      const after = await find(repo, url);
      if (!after) return;
      watched.push(after);
      add(fileChange(url, node, before, after, cache));
    })
  );

  return {
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    watched,
  };
}

// Files a folder gained or lost on the draft. One that only moved elsewhere
// in the tree isn't lost.
async function folderChanges(
  repo: Repo,
  tree: Tree,
  node: Node,
  before: DocHandle<unknown> | null,
  cache: CountCache
): Promise<FileChange[]> {
  const was = before ? linksOf(before.doc()) : [];
  const now = linksOf(node.folder?.doc());
  const wasUrls = new Set(was.map((link) => link.url));
  const nowUrls = new Set(now.map((link) => link.url));

  const lost = was
    .filter((link) => !nowUrls.has(link.url) && !tree.has(link.url))
    .map(async (link): Promise<FileChange | null> => {
      const place = childPlace(node, link, was);
      if (link.folder) {
        return { url: link.url, ...place, status: "deleted", added: null, removed: null };
      }
      const doc = await find(repo, link.url);
      return doc && fileChange(link.url, place, doc, null, cache);
    });

  const gained = now
    .filter((link) => !wasUrls.has(link.url))
    .flatMap((link) => {
      const place = childPlace(node, link, now);
      // A new folder brings everything in it.
      if (!link.folder) return [{ url: link.url, place }];
      return [...tree]
        .filter(([, n]) => !n.folder && n.path.startsWith(`${place.path}/`))
        .map(([url, n]) => ({ url, place: n as Place }));
    })
    .map(async ({ url, place }) => {
      const doc = await find(repo, url);
      return doc && fileChange(url, place, null, doc, cache);
    });

  const changes = await Promise.all([...lost, ...gained]);
  return changes.filter((change): change is FileChange => change !== null);
}

// What one file's change comes to; null when it comes to nothing.
function fileChange(
  url: AutomergeUrl,
  place: Place,
  before: DocHandle<unknown> | null,
  after: DocHandle<unknown> | null,
  cache: CountCache
): FileChange | null {
  const status = !before ? "added" : !after ? "deleted" : "modified";
  const key = [url, before?.heads().join(",") ?? "", after?.heads().join(",") ?? ""].join("|");
  let counts = cache.get(key);
  if (counts === undefined) {
    counts = countLines(
      before ? textOf(before.doc()) : "",
      after ? textOf(after.doc()) : ""
    );
    cache.set(key, counts);
  }
  if (status === "modified" && counts && counts.added === 0 && counts.removed === 0) {
    return null;
  }
  return {
    url,
    path: place.path,
    location: place.location,
    status,
    added: counts?.added ?? null,
    removed: counts?.removed ?? null,
  };
}

/** Lines added and removed going from `before` to `after`; null if either isn't text. */
export function countLines(before: string | null, after: string | null): Counts | null {
  if (before === null || after === null) return null;
  const parts = diffLines(before, after, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) return null;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** A file doc's text, whichever way it's stored; null when it isn't text. */
export function textOf(doc: unknown): string | null {
  const content = (doc as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (isImmutableString(content)) return String(content);
  if (content instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The entries of a folder doc (`docs`) or a pushwork directory doc (a path
 * per key); none for anything else.
 */
export function linksOf(doc: unknown): Link[] {
  const d = doc as Record<string, unknown> | undefined;
  if (!d) return [];
  if (Array.isArray(d.docs)) {
    return d.docs.flatMap((entry) => {
      const url = asUrl(entry?.url);
      if (!url) return [];
      const type = asString(entry?.type);
      return [{ url, name: asString(entry?.name) ?? "", folder: isFolderType(type) }];
    });
  }
  if (isDirectory(d)) {
    return Object.entries(d).flatMap(([key, value]) => {
      const url = key === "@patchwork" || key === "lastSyncAt" ? undefined : asUrl(value);
      return url ? [{ url, name: key, folder: false }] : [];
    });
  }
  return [];
}

// The tree under `root` as the draft has it, by doc. Only folders are loaded.
async function walkTree(repo: Repo, root: AutomergeUrl): Promise<Tree> {
  const tree: Tree = new Map();
  const visit = async (url: AutomergeUrl, place: Place): Promise<void> => {
    const node: Node = { ...place, folder: null };
    tree.set(url, node);
    const handle = await find(repo, url);
    if (!handle) return;
    const links = linksOf(handle.doc());
    if (!links.length && !isFolderDoc(handle.doc())) return;
    node.folder = handle;
    const folders: Promise<void>[] = [];
    for (const link of links) {
      if (tree.has(link.url)) continue;
      const child = childPlace(place, link, links);
      if (link.folder) folders.push(visit(link.url, child));
      else tree.set(link.url, { ...child, folder: null });
    }
    await Promise.all(folders);
  };
  await visit(root, { path: "", location: root });
  return tree;
}

function childPlace(parent: Place, link: Link, siblings: Link[]): Place {
  const clash = siblings.some(
    (sibling) => sibling.url !== link.url && sibling.name === link.name
  );
  const segment =
    link.name && !clash ? link.name : parseAutomergeUrl(link.url).documentId;
  const name = link.name || "Untitled";
  return {
    path: parent.path ? `${parent.path}/${name}` : name,
    location: `${parent.location}/${encodeURIComponent(segment)}` as AutomergeUrl,
  };
}

async function atFork(repo: Repo, entry: CloneEntry): Promise<DocHandle<unknown> | null> {
  if (!entry.cloneUrl || entry.clonedAt.length === 0) return null;
  const { documentId } = parseAutomergeUrl(entry.cloneUrl);
  return find(repo, stringifyAutomergeUrl({ documentId, heads: entry.clonedAt }));
}

async function find(repo: Repo, url: AutomergeUrl): Promise<DocHandle<unknown> | null> {
  try {
    return await repo.find<unknown>(url);
  } catch (err) {
    console.warn("[review] couldn't load", url, err);
    return null;
  }
}

function isFolderDoc(doc: unknown): boolean {
  const d = doc as Record<string, unknown> | undefined;
  return !!d && (Array.isArray(d.docs) || isDirectory(d));
}

function isDirectory(doc: Record<string, unknown>): boolean {
  const meta = doc["@patchwork"] as { type?: unknown } | undefined;
  return asString(meta?.type) === "directory";
}

function isFolderType(type: string | undefined): boolean {
  return type === "folder" || type === "directory";
}

function canonical(url: AutomergeUrl): AutomergeUrl {
  return stringifyAutomergeUrl({ documentId: parseAutomergeUrl(url).documentId });
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isImmutableString(value)) return String(value);
  return undefined;
}

function asUrl(value: unknown): AutomergeUrl | undefined {
  const s = asString(value);
  return s !== undefined && isValidAutomergeUrl(s) ? canonical(s) : undefined;
}
