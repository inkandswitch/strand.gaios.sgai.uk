import * as Automerge from "@automerge/automerge/slim";
import {
  decodeHeads,
  encodeHeads,
  isImmutableString,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import type { DraftDoc } from "../draft-types.js";
import { canonicalUrl } from "../clone-policy.js";
import { cloneAt } from "../draft-clones.js";
import { asText, blobSha, toBytes, type FileContent } from "./blob.js";
import type { Remote, TreeEntry } from "./remote.js";

// A workspace's files as one of its drafts sees them. A folder doc is
// `{ title, docs: [{ name, type, url }] }`; a file doc is
// `{ name, extension, mimeType, content }`, its content a string (editable
// text), an ImmutableString, or bytes. Paths are the folder entries' names,
// joined with "/". Other docs in a folder aren't files, and aren't synced.

// The docs a line reads and writes: main's originals, or a draft's versions
// of them. `draft` null is main.
export type Line = {
  repo: Repo;
  root: AutomergeUrl;
  draft: DocHandle<DraftDoc> | null;
};

export type FileEntry = {
  path: string;
  // the original url: the same in every draft
  doc: AutomergeUrl;
  content: FileContent;
  // how the doc stores it
  kind: "text" | "immutable" | "bytes";
};

export type Snapshot = {
  files: Map<string, FileEntry>;
  // folder path ("" for the root) → folder doc
  folders: Map<string, AutomergeUrl>;
  // the heads of every folder and file doc read
  heads: Record<AutomergeUrl, UrlHeads>;
};

type FolderDoc = {
  title?: string;
  docs?: { name?: unknown; type?: unknown; url?: unknown }[];
};

type FileDoc = {
  name?: string;
  extension?: string;
  mimeType?: string;
  content?: unknown;
};

// The line's files as they are, or as they were at `at` (docs missing from
// `at` didn't exist then and are left out).
export async function readFiles(
  line: Line,
  at?: Record<AutomergeUrl, UrlHeads>,
): Promise<Snapshot> {
  const snapshot: Snapshot = { files: new Map(), folders: new Map(), heads: {} };
  const seen = new Set<AutomergeUrl>();

  const read = async (url: AutomergeUrl) => {
    if (at && !at[url]) return null;
    try {
      const handle = at
        ? await line.repo.find<unknown>(readUrlAt(line, url, at[url]))
        : await line.repo.find<unknown>(readUrl(line, url));
      return {
        doc: handle.doc() as unknown,
        heads: at ? at[url] : handle.heads(),
      };
    } catch (err) {
      console.warn("[git] couldn't read", url, err);
      return null;
    }
  };

  const walk = async (url: AutomergeUrl, path: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    const folder = await read(url);
    if (!folder || !isFolder(folder.doc)) return;
    snapshot.folders.set(path, url);
    snapshot.heads[url] = folder.heads;
    const children = (folder.doc as FolderDoc).docs ?? [];
    await Promise.all(
      children.map(async (link) => {
        const child = linkUrl(link.url);
        const name = asString(link.name);
        if (!child || !name || name.includes("/") || seen.has(child)) return;
        const childPath = path ? `${path}/${name}` : name;
        if (asString(link.type) === "folder") return walk(child, childPath);
        const entry = await read(child);
        if (!entry) return;
        if (isFolder(entry.doc)) return walk(child, childPath);
        const file = fileContent(entry.doc);
        if (!file || snapshot.files.has(childPath)) return;
        seen.add(child);
        snapshot.heads[child] = entry.heads;
        snapshot.files.set(childPath, { path: childPath, doc: child, ...file });
      }),
    );
  };

  await walk(canonicalUrl(line.root), "");
  return snapshot;
}

// The git changes that turn `tree` into the snapshot's files: what's
// different, and what's gone. Entries git has that strand doesn't model
// (symlinks, submodules) are left as they are.
export async function changesFrom(
  tree: TreeEntry[],
  snapshot: Snapshot,
): Promise<{ path: string; mode: string; content: Uint8Array | null }[]> {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  const changes: { path: string; mode: string; content: Uint8Array | null }[] = [];
  for (const file of snapshot.files.values()) {
    const existing = byPath.get(file.path);
    if (existing && !synced(existing)) continue;
    if (existing && existing.sha === (await blobSha(file.content))) continue;
    changes.push({
      path: file.path,
      mode: existing?.mode ?? "100644",
      content: toBytes(file.content),
    });
  }
  for (const entry of tree) {
    if (synced(entry) && !snapshot.files.has(entry.path)) {
      changes.push({ path: entry.path, mode: entry.mode, content: null });
    }
  }
  return changes;
}

// Whether a tree entry is a file strand keeps: regular and executable files.
export function synced(entry: TreeEntry): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

// Make the line's files those of `tree`, writing every change as if made at
// `anchor`, the version both sides last agreed on: edits made here since are
// concurrent with it, and merge with it as any two drafts' edits would.
// `addOnly` only brings in files the line doesn't have. Returns the heads of
// the version the import made — `anchor` with each doc it touched moved on —
// which is the tree's version.
export async function importTree(
  line: Line,
  remote: Remote,
  anchor: Record<AutomergeUrl, UrlHeads>,
  tree: TreeEntry[],
  options: { addOnly?: boolean } = {},
): Promise<{ heads: Record<AutomergeUrl, UrlHeads>; touched: string[] }> {
  const before = await readFiles(line, anchor);
  const heads = { ...anchor };
  const touched: string[] = [];

  type Edit = { path: string; bytes: Uint8Array };
  const modified: (Edit & { file: FileEntry })[] = [];
  const added: Edit[] = [];
  const removed: FileEntry[] = [];
  const wanted = tree.filter(synced);
  const wantedPaths = new Set(wanted.map((entry) => entry.path));

  await Promise.all(
    wanted.map(async (entry) => {
      const file = before.files.get(entry.path);
      if (file && options.addOnly) return;
      if (file && (await blobSha(file.content)) === entry.sha) return;
      const bytes = await remote.readBlob(entry.sha);
      if (file) modified.push({ path: entry.path, bytes, file });
      else added.push({ path: entry.path, bytes });
    }),
  );
  if (!options.addOnly) {
    for (const file of before.files.values()) {
      if (!wantedPaths.has(file.path)) removed.push(file);
    }
  }
  if (!modified.length && !added.length && !removed.length) {
    return { heads, touched };
  }

  // Everything is loaded and made ready first, then written in one go, so an
  // import doesn't stop half done.
  const links = new Map<AutomergeUrl, { add: Link[]; remove: Set<AutomergeUrl> }>();
  const linksOf = (folder: AutomergeUrl) => {
    let entry = links.get(folder);
    if (!entry) links.set(folder, (entry = { add: [], remove: new Set() }));
    return entry;
  };
  const created = new Map<string, DocHandle<FolderDoc>>();
  const folderAt = (dir: string): AutomergeUrl => {
    const existing = before.folders.get(dir);
    if (existing) return existing;
    const made = created.get(dir);
    if (made) return made.url;
    const folder = line.repo.create<FolderDoc>({
      "@patchwork": { type: "folder" },
      title: basename(dir),
      docs: [],
    } as FolderDoc);
    created.set(dir, folder);
    linksOf(folderAt(dirname(dir))).add.push({
      name: basename(dir),
      type: "folder",
      url: folder.url,
    });
    return folder.url;
  };

  const newFiles: DocHandle<FileDoc>[] = [];
  for (const { path, bytes } of added) {
    const text = asText(bytes);
    const name = basename(path);
    const handle = line.repo.create<FileDoc>({
      "@patchwork": { type: "file" },
      name,
      extension: extensionOf(name),
      mimeType: mimeTypeOf(name, text !== null),
      content: text ?? bytes,
    } as FileDoc);
    newFiles.push(handle);
    linksOf(folderAt(dirname(path))).add.push({
      name,
      type: "file",
      url: handle.url,
    });
    touched.push(path);
  }
  for (const file of removed) {
    const dir = dirname(file.path);
    linksOf(before.folders.get(dir)!).remove.add(file.doc);
    delete heads[file.doc];
    touched.push(file.path);
  }

  const writable = new Map<AutomergeUrl, DocHandle<unknown>>();
  const toWrite = [
    ...modified.map((m) => m.file.doc),
    ...[...links.keys()].filter((url) => !isCreated(url)),
  ];
  function isCreated(url: AutomergeUrl) {
    return [...created.values()].some((handle) => handle.url === url);
  }
  for (const url of toWrite) {
    writable.set(url, await writableHandle(line, url));
  }

  for (const { path, bytes, file } of modified) {
    const handle = writable.get(file.doc)!;
    const moved = handle.changeAt(anchor[file.doc], (doc) =>
      setContent(doc as FileDoc, file.kind, bytes),
    );
    if (moved) heads[file.doc] = moved;
    touched.push(path);
  }
  for (const [url, change] of links) {
    const apply = (doc: FolderDoc) => {
      doc.docs ??= [];
      for (let i = doc.docs.length - 1; i >= 0; i--) {
        const link = linkUrl(doc.docs[i]?.url);
        if (link && change.remove.has(link)) doc.docs.splice(i, 1);
      }
      for (const link of change.add) doc.docs.push(link);
    };
    const made = [...created.values()].find((handle) => handle.url === url);
    if (made) {
      made.change(apply);
    } else {
      const moved = writable.get(url)!.changeAt(anchor[url], (doc) => apply(doc as FolderDoc));
      if (moved) heads[url] = moved;
    }
  }
  for (const handle of [...created.values(), ...newFiles]) {
    heads[handle.url] = handle.heads();
  }
  if (line.draft) {
    const urls = [...created.values(), ...newFiles].map((handle) => handle.url);
    line.draft.change((d) => {
      for (const url of urls) d.clones[url] = { cloneUrl: url, clonedAt: encodeHeads([]) };
    });
  }
  return { heads, touched };
}

type Link = { name: string; type: string; url: AutomergeUrl };

function setContent(doc: FileDoc, kind: FileEntry["kind"], bytes: Uint8Array) {
  const text = asText(bytes);
  if (kind === "text" && text !== null) {
    Automerge.updateText(doc as Automerge.Doc<unknown>, ["content"], text);
  } else if (kind === "immutable" && text !== null) {
    doc.content = new Automerge.ImmutableString(text);
  } else if (kind === "bytes" || text === null) {
    doc.content = bytes;
  } else {
    doc.content = text;
  }
}

// --- Reading and writing a line's docs ---------------------------------------

// Where the line reads `url` now.
export function readUrl(line: Line, url: AutomergeUrl): AutomergeUrl {
  const entry = line.draft?.doc()?.clones?.[url];
  if (!entry) return url;
  if (entry.cloneUrl) return entry.cloneUrl;
  return stringifyAutomergeUrl({
    documentId: parseAutomergeUrl(entry.source ?? url).documentId,
    heads: entry.clonedAt,
  });
}

// Where the line reads `url` as of `heads`: the line's version shares the
// original's history, so the same heads name the same version in it.
export function readUrlAt(line: Line, url: AutomergeUrl, heads: UrlHeads): AutomergeUrl {
  const entry = line.draft?.doc()?.clones?.[url];
  const copy = entry?.cloneUrl ?? entry?.source ?? url;
  return stringifyAutomergeUrl({
    documentId: parseAutomergeUrl(copy).documentId,
    heads,
  });
}

// The line's own copy of `url`, to write: main's original, or the draft's
// clone, made now (at the draft's fork point) if it hasn't one yet.
export async function writableHandle(line: Line, url: AutomergeUrl): Promise<DocHandle<unknown>> {
  const draft = line.draft;
  if (!draft) return line.repo.find<unknown>(url);
  const entry = draft.doc()?.clones?.[url];
  if (entry?.cloneUrl) return line.repo.find<unknown>(entry.cloneUrl);
  const source = await line.repo.find<unknown>(entry?.source ?? url);
  const clonedAt = entry?.clonedAt ?? source.heads();
  const clone = cloneAt(line.repo, source, clonedAt);
  const cloneUrl = canonicalUrl(clone.url);
  draft.change((d) => {
    const e = d.clones[url];
    if (e) e.cloneUrl = cloneUrl;
    else d.clones[url] = { cloneUrl, clonedAt };
  });
  return clone;
}

// The heads the line's copy of `url` is at, and the doc holding its history.
export async function currentVersion(
  line: Line,
  url: AutomergeUrl,
): Promise<{ doc: Automerge.Doc<unknown>; heads: UrlHeads }> {
  const entry = line.draft?.doc()?.clones?.[url];
  const copy = entry?.cloneUrl ?? entry?.source ?? url;
  const handle = await line.repo.find<unknown>(copy);
  const heads = entry && !entry.cloneUrl ? entry.clonedAt : handle.heads();
  return { doc: handle.doc() as Automerge.Doc<unknown>, heads };
}

// Whether every change in `a` is in `b`'s history, in `doc`.
export function isAncestor(doc: Automerge.Doc<unknown>, a: UrlHeads, b: UrlHeads): boolean {
  const ours = decodeHeads(a);
  const theirs = decodeHeads(b);
  if (!Automerge.hasHeads(doc, ours) || !Automerge.hasHeads(doc, theirs)) return false;
  const after = new Set(Automerge.getChangesMetaSince(doc, theirs).map((m) => m.hash));
  return ours.every((hash) => !after.has(hash));
}

// The newest of `heads`: none that another of them descends from.
export function frontier(doc: Automerge.Doc<unknown>, heads: UrlHeads): UrlHeads {
  const unique = [...new Set(heads)] as UrlHeads;
  return unique.filter(
    (hash) =>
      !unique.some(
        (other) => other !== hash && isAncestor(doc, [hash] as UrlHeads, [other] as UrlHeads),
      ),
  ) as UrlHeads;
}

export function sameHeads(a: UrlHeads | undefined, b: UrlHeads | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((hash) => set.has(hash));
}

// --- Doc shapes ---------------------------------------------------------------

function isFolder(doc: unknown): boolean {
  return !!doc && typeof doc === "object" && Array.isArray((doc as FolderDoc).docs);
}

function fileContent(doc: unknown): Pick<FileEntry, "content" | "kind"> | null {
  if (!doc || typeof doc !== "object") return null;
  const content = (doc as FileDoc).content;
  if (typeof content === "string") return { content, kind: "text" };
  if (isImmutableString(content)) return { content: content.toString(), kind: "immutable" };
  if (content instanceof Uint8Array) return { content, kind: "bytes" };
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isImmutableString(value)) return value.toString();
  return undefined;
}

function linkUrl(value: unknown): AutomergeUrl | undefined {
  const url = asString(value);
  return url && isValidAutomergeUrl(url) ? canonicalUrl(url) : undefined;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/tsx",
  jsx: "text/jsx",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

function mimeTypeOf(name: string, text: boolean): string {
  return (
    MIME[extensionOf(name).toLowerCase()] ?? (text ? "text/plain" : "application/octet-stream")
  );
}
