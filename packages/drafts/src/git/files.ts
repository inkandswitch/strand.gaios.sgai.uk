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
import { isAttributesFile, rulesOf, type Rules } from "./attributes.js";
import { blobSha, toBytes, type FileContent } from "./blob.js";
import {
  documentValueOf,
  fileValueOf,
  formatJson,
  isFileEntryDoc,
  jsonDocumentOf,
  jsonEquals,
  jsonLinkType,
  jsonValueOf,
  parseJsonObject,
  patchJson,
  type JsonObject,
} from "./json.js";
import { updateTextByLines } from "./text.js";
import type { Remote, TreeEntry } from "./remote.js";

// A workspace's files as one of its drafts sees them, mapped the way pushwork
// maps a folder to disk, so git and a pushwork checkout of the same folder
// hold the same files:
//
// - a folder doc is `{ title, docs: [{ name, type, url }] }`, and paths are
//   the entries' names joined with "/";
// - a file doc (`{ content }`, typed `file` or not typed) is its content: a
//   string (editable text), an ImmutableString (an artifact), or bytes;
// - any other doc is a JSON document, and its file is its JSON value, without
//   `@patchwork` when the path's `.pushworkattributes` rule says
//   `strip-metadata`, laid out like the file git has.
//
// `.pushworkattributes` rules also decide what comes in from git: a file a
// `datatype=` rule covers becomes a JSON document of that type, and an
// `artifact` file's text is stored whole. A doc that can't be read is left
// alone on both sides.

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
} & (
  | { kind: "text" | "immutable" | "bytes"; content: FileContent }
  // a JSON document's whole value, `@patchwork` included
  | { kind: "json"; value: JsonObject }
);

export type Snapshot = {
  files: Map<string, FileEntry>;
  // folder path ("" for the root) → folder doc
  folders: Map<string, AutomergeUrl>;
  // the heads of every folder and leaf doc read
  heads: Record<AutomergeUrl, UrlHeads>;
  // paths whose doc couldn't be read: never written, never deleted
  unreadable: Set<string>;
};

type FolderDoc = {
  title?: string;
  docs?: { name?: unknown; type?: unknown; url?: unknown }[];
};

type FileDoc = {
  "@patchwork"?: { type: string };
  name?: string;
  extension?: string;
  mimeType?: string;
  content?: unknown;
};

type Change = { path: string; mode: string; content: Uint8Array | null };

// The line's files as they are, or as they were at `at` (docs missing from
// `at` didn't exist then and are left out).
export async function readFiles(
  line: Line,
  at?: Record<AutomergeUrl, UrlHeads>,
): Promise<Snapshot> {
  const snapshot: Snapshot = {
    files: new Map(),
    folders: new Map(),
    heads: {},
    unreadable: new Set(),
  };
  const seen = new Set<AutomergeUrl>();

  const read = async (url: AutomergeUrl) => {
    try {
      const handle = at
        ? await line.repo.find<unknown>(readUrlAt(line, url, at[url]))
        : await line.repo.find<unknown>(readUrl(line, url));
      return { doc: handle.doc() as unknown, heads: at ? at[url] : handle.heads() };
    } catch (err) {
      console.warn("[git] couldn't read", url, err);
      return null;
    }
  };

  const walk = async (url: AutomergeUrl, path: string) => {
    if (seen.has(url) || (at && !at[url])) return;
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
        if (at && !at[child]) return;
        const entry = await read(child);
        if (!entry) {
          snapshot.unreadable.add(childPath);
          return;
        }
        if (isFolder(entry.doc)) return walk(child, childPath);
        if (snapshot.files.has(childPath)) return;
        const leaf = leafOf(entry.doc);
        if (!leaf) {
          snapshot.unreadable.add(childPath);
          return;
        }
        seen.add(child);
        snapshot.heads[child] = entry.heads;
        snapshot.files.set(childPath, { path: childPath, doc: child, ...leaf });
      }),
    );
  };

  await walk(canonicalUrl(line.root), "");
  return snapshot;
}

// The rules the snapshot's own `.pushworkattributes` files set.
export function snapshotRules(snapshot: Snapshot): Rules {
  const files = new Map<string, Uint8Array>();
  for (const file of snapshot.files.values()) {
    if (isAttributesFile(file.path) && file.kind !== "json") {
      files.set(file.path, toBytes(file.content));
    }
  }
  return rulesOf(files);
}

// The git changes that turn `tree` into the snapshot's files: what's
// different, and what's gone. Entries git has that strand doesn't model
// (symlinks, submodules) and paths whose doc couldn't be read are left as
// they are. A JSON document counts as changed when its value differs from
// the file's, whatever the layout.
export async function changesFrom(
  tree: TreeEntry[],
  snapshot: Snapshot,
  remote: Remote,
): Promise<Change[]> {
  const rules = snapshotRules(snapshot);
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  const changes: Change[] = [];
  for (const file of snapshot.files.values()) {
    const existing = byPath.get(file.path);
    if (existing && !synced(existing)) continue;
    const mode = existing?.mode ?? "100644";
    if (file.kind !== "json") {
      if (existing && existing.sha === (await blobSha(file.content))) continue;
      changes.push({ path: file.path, mode, content: toBytes(file.content) });
      continue;
    }
    const value = fileValueOf(file.value, rules.datatypeOf(file.path)?.stripMetadata ?? false);
    const template = existing ? await remote.readBlob(existing.sha) : undefined;
    const current = template ? parseJsonObject(template) : undefined;
    if (current && jsonEquals(value, current)) continue;
    changes.push({ path: file.path, mode, content: formatJson(value, template) });
  }
  for (const entry of tree) {
    if (!synced(entry) || snapshot.files.has(entry.path) || snapshot.unreadable.has(entry.path)) {
      continue;
    }
    changes.push({ path: entry.path, mode: entry.mode, content: null });
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
  const wanted = tree.filter((entry) => synced(entry) && !before.unreadable.has(entry.path));
  const kept = new Set(tree.filter((entry) => !synced(entry)).map((entry) => entry.path));
  const rules = await treeRules(remote, wanted);

  type Edit = { path: string; bytes: Uint8Array };
  const modified: (Edit & { file: FileEntry })[] = [];
  const patched: { path: string; file: FileEntry; value: JsonObject }[] = [];
  const added: (Edit & { replaces?: FileEntry })[] = [];
  const removed: FileEntry[] = [];
  const wantedPaths = new Set(wanted.map((entry) => entry.path));

  await Promise.all(
    wanted.map(async (entry) => {
      const file = before.files.get(entry.path);
      if (file && options.addOnly) return;
      const datatype = rules.datatypeOf(entry.path);
      if (file?.kind === "json") {
        const parsed = parseJsonObject(await remote.readBlob(entry.sha));
        if (!parsed) {
          console.warn(
            `[git] ${entry.path} is a JSON document, but git's file isn't a JSON object; leaving it`,
          );
          return;
        }
        const value = documentValueOf(parsed, file.value["@patchwork"], datatype);
        if (!jsonEquals(value, file.value)) patched.push({ path: entry.path, file, value });
        return;
      }
      if (file && !datatype && (await blobSha(file.content)) === entry.sha) return;
      const bytes = await remote.readBlob(entry.sha);
      if (file && datatype && jsonDocumentOf(bytes, datatype)) {
        // A file a datatype rule covers becomes a JSON document, as pushwork
        // converts it.
        added.push({ path: entry.path, bytes, replaces: file });
      } else if (file) {
        if ((await blobSha(file.content)) !== entry.sha) {
          modified.push({ path: entry.path, bytes, file });
        }
      } else {
        added.push({ path: entry.path, bytes });
      }
    }),
  );
  if (!options.addOnly) {
    for (const file of before.files.values()) {
      if (!wantedPaths.has(file.path) && !kept.has(file.path)) removed.push(file);
    }
  }
  if (!modified.length && !patched.length && !added.length && !removed.length) {
    return { heads, touched };
  }

  // Everything is loaded and made ready first, then written in one go, so an
  // import doesn't stop half done.
  type FolderEdit = {
    add: Link[];
    remove: Set<AutomergeUrl>;
    repin: Map<AutomergeUrl, AutomergeUrl>;
  };
  const links = new Map<AutomergeUrl, FolderEdit>();
  const linksOf = (folder: AutomergeUrl) => {
    let entry = links.get(folder);
    if (!entry) links.set(folder, (entry = { add: [], remove: new Set(), repin: new Map() }));
    return entry;
  };
  const created = new Map<string, DocHandle<FolderDoc>>();
  const isCreated = (url: AutomergeUrl) =>
    [...created.values()].some((handle) => handle.url === url);
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

  const newDocs: DocHandle<unknown>[] = [];
  for (const { path, bytes, replaces } of added) {
    const name = basename(path);
    const datatype = rules.datatypeOf(path);
    const json = datatype ? jsonDocumentOf(bytes, datatype) : undefined;
    const handle = (
      json
        ? line.repo.create<JsonObject>(json)
        : line.repo.create<FileDoc>(makeFileEntry(path, bytes, rules.isArtifact(path)))
    ) as DocHandle<unknown>;
    newDocs.push(handle);
    const edit = linksOf(folderAt(dirname(path)));
    if (replaces) {
      edit.remove.add(replaces.doc);
      delete heads[replaces.doc];
    }
    edit.add.push({
      name,
      type: (json && jsonLinkType(json)) || linkFileType(name),
      url: !json && rules.isArtifact(path) ? pinned(handle) : handle.url,
    });
    touched.push(path);
  }
  for (const file of removed) {
    linksOf(before.folders.get(dirname(file.path))!).remove.add(file.doc);
    delete heads[file.doc];
    touched.push(file.path);
  }
  for (const { path, file } of modified) {
    // An artifact is linked pinned to its version, as pushwork links it.
    if (rules.isArtifact(path))
      linksOf(before.folders.get(dirname(path))!).repin.set(file.doc, file.doc);
  }

  const writable = new Map<AutomergeUrl, DocHandle<unknown>>();
  const toWrite = [
    ...modified.map((m) => m.file.doc),
    ...patched.map((p) => p.file.doc),
    ...links.keys(),
  ].filter((url) => !isCreated(url));
  for (const url of toWrite) {
    if (!writable.has(url)) writable.set(url, await writableHandle(line, url));
  }

  for (const { path, bytes, file } of modified) {
    const fresh = makeFileEntry(path, bytes, rules.isArtifact(path));
    const moved = writable
      .get(file.doc)!
      .changeAt(anchor[file.doc], (doc) => mutateFileEntry(doc as FileDoc, fresh));
    if (moved) heads[file.doc] = moved;
    const repin = links.get(before.folders.get(dirname(path))!)?.repin;
    if (repin?.has(file.doc)) {
      repin.set(
        file.doc,
        stringifyAutomergeUrl({
          documentId: parseAutomergeUrl(file.doc).documentId,
          heads: heads[file.doc],
        }),
      );
    }
    touched.push(path);
  }
  for (const { path, file, value } of patched) {
    const moved = writable
      .get(file.doc)!
      .changeAt(anchor[file.doc], (doc) => patchJson(doc as JsonObject, value));
    if (moved) heads[file.doc] = moved;
    touched.push(path);
  }
  for (const [url, change] of links) {
    const apply = (doc: FolderDoc) => {
      doc.docs ??= [];
      for (let i = doc.docs.length - 1; i >= 0; i--) {
        const link = linkUrl(doc.docs[i]?.url);
        if (!link) continue;
        if (change.remove.has(link)) doc.docs.splice(i, 1);
        else if (change.repin.has(link)) doc.docs[i].url = change.repin.get(link)!;
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
  for (const handle of [...created.values(), ...newDocs]) {
    heads[handle.url] = handle.heads();
  }
  if (line.draft) {
    const urls = [...created.values(), ...newDocs].map((handle) => handle.url);
    line.draft.change((d) => {
      for (const url of urls) d.clones[url] = { cloneUrl: url, clonedAt: encodeHeads([]) };
    });
  }
  return { heads, touched };
}

type Link = { name: string; type: string; url: AutomergeUrl };

// The rules the tree's own `.pushworkattributes` files set: what comes in
// from git is stored the way those rules say, as pushwork stores what's on
// disk by the rules on disk.
async function treeRules(remote: Remote, tree: TreeEntry[]): Promise<Rules> {
  const files = new Map<string, Uint8Array>();
  for (const entry of tree) {
    if (isAttributesFile(entry.path)) files.set(entry.path, await remote.readBlob(entry.sha));
  }
  return rulesOf(files);
}

// --- File docs (pushwork's `shapes/file.ts`) ----------------------------------

// A file's content as pushwork stores it: UTF-8 text as editable text (an
// atomic ImmutableString for an artifact), anything else as bytes.
function bytesToContent(
  bytes: Uint8Array,
  isArtifact: boolean,
): string | Uint8Array | Automerge.ImmutableString {
  if (bytes.includes(0)) return bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
  const reencoded = new TextEncoder().encode(text);
  if (reencoded.length !== bytes.length) return bytes;
  for (let i = 0; i < bytes.length; i++) if (reencoded[i] !== bytes[i]) return bytes;
  return isArtifact ? new Automerge.ImmutableString(text) : text;
}

function makeFileEntry(path: string, bytes: Uint8Array, isArtifact: boolean): FileDoc {
  const name = basename(path);
  return {
    "@patchwork": { type: "file" },
    content: bytesToContent(bytes, isArtifact),
    extension: extensionOf(name),
    mimeType: mimeTypeOf(name),
    name,
  };
}

// Mutate a file doc (inside a change) to match `fresh`: text is spliced, so
// concurrent edits merge; bytes and ImmutableStrings are replaced whole.
function mutateFileEntry(d: FileDoc, fresh: FileDoc): void {
  const current = d.content;
  const next = fresh.content;
  if (!contentEquals(current, next)) {
    if (typeof current === "string" && typeof next === "string") {
      updateTextByLines(d, ["content"], current, next);
    } else {
      d.content = next;
    }
  }
  if (d.extension !== fresh.extension) d.extension = fresh.extension;
  if (d.mimeType !== fresh.mimeType) d.mimeType = fresh.mimeType;
  if (d.name !== fresh.name) d.name = fresh.name;
  if (!d["@patchwork"]) d["@patchwork"] = { type: "file" };
}

function contentEquals(a: unknown, b: unknown): boolean {
  const bytes = (c: unknown) =>
    c instanceof Uint8Array
      ? c
      : new TextEncoder().encode(isImmutableString(c) ? c.toString() : String(c ?? ""));
  const x = bytes(a);
  const y = bytes(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function pinned(handle: DocHandle<unknown>): AutomergeUrl {
  return stringifyAutomergeUrl({ documentId: handle.documentId, heads: handle.heads() });
}

// How pushwork's patchwork-folder shape types a file link: by extension.
function linkFileType(name: string): string {
  return extensionOf(name) || "file";
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
  return stringifyAutomergeUrl({ documentId: parseAutomergeUrl(copy).documentId, heads });
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

// What a leaf doc is to git: a file's content, or a JSON document's value.
function leafOf(
  doc: unknown,
):
  | { kind: "text" | "immutable" | "bytes"; content: FileContent }
  | { kind: "json"; value: JsonObject }
  | null {
  if (!doc || typeof doc !== "object") return null;
  if (!isFileEntryDoc(doc)) return { kind: "json", value: jsonValueOf(doc) };
  const content = (doc as FileDoc).content;
  if (typeof content === "string") return { kind: "text", content };
  if (isImmutableString(content)) return { kind: "immutable", content: content.toString() };
  if (content instanceof Uint8Array) return { kind: "bytes", content };
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

// pushwork looks types up with the `mime-types` package, which needs Node.
// These are its answers for common extensions; others fall back as there.
const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  csv: "text/csv",
  js: "application/javascript",
  mjs: "application/javascript",
  ts: "video/mp2t",
  jsx: "text/jsx",
  json: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "application/toml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  wasm: "application/wasm",
  sh: "application/x-sh",
  xml: "application/xml",
};

function mimeTypeOf(name: string): string {
  return MIME[extensionOf(name).toLowerCase()] ?? "application/octet-stream";
}
