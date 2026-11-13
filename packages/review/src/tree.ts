import {
  isImmutableString,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo/slim";

// Where a doc is in the tree: its path by name, and its location, which is
// what the project frame opens documents by: `automerge:<root>/<segment>/...`,
// each segment an entry's name, or its document id when the name is empty or
// a sibling's too.
type Place = { path: string; location: AutomergeUrl };
type Link = { url: AutomergeUrl; name: string; folder: boolean; type?: string };
// `parent` is the folder linking it, null for the root; `type` the one its
// link gives, if any.
export type Node = Place & {
  name: string;
  type: string | undefined;
  parent: AutomergeUrl | null;
  folder: DocHandle<unknown> | null;
};
export type Tree = Map<AutomergeUrl, Node>;

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
      const link: Link = { url, name: asString(entry?.name) ?? "", folder: isFolderType(type) };
      return [type ? { ...link, type } : link];
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
export async function walkTree(repo: Repo, root: AutomergeUrl): Promise<Tree> {
  const tree: Tree = new Map();
  const visit = async (url: AutomergeUrl, node: Node): Promise<void> => {
    tree.set(url, node);
    const handle = await find(repo, url);
    if (!handle) return;
    const links = linksOf(handle.doc());
    if (!links.length && !isFolderDoc(handle.doc())) return;
    node.folder = handle;
    const folders: Promise<void>[] = [];
    for (const link of links) {
      if (tree.has(link.url)) continue;
      const child: Node = {
        ...childPlace(node, link, links),
        name: link.name || "Untitled",
        type: link.type,
        parent: url,
        folder: null,
      };
      if (link.folder) folders.push(visit(link.url, child));
      else tree.set(link.url, child);
    }
    await Promise.all(folders);
  };
  await visit(root, {
    path: "",
    location: root,
    name: "",
    type: undefined,
    parent: null,
    folder: null,
  });
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

export async function find(repo: Repo, url: AutomergeUrl): Promise<DocHandle<unknown> | null> {
  try {
    return await repo.find<unknown>(url);
  } catch (err) {
    console.warn("[compare] couldn't load", url, err);
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

export function canonical(url: AutomergeUrl): AutomergeUrl {
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
