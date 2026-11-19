import * as Automerge from "@automerge/automerge/slim";
import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim";

import type { Datatype } from "./attributes.js";

// Copied from pushwork's `src/shapes/json.ts`: a leaf doc that isn't a file
// is a JSON document, and becomes a file the way pushwork writes it to disk.
// Keep the two in step by hand.

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// `@patchwork.type`s that mean something structural to pushwork or
// Patchwork; a JSON document claiming one of them is linked by extension.
const RESERVED_TYPES = new Set(["file", "folder", "directory", "branches"]);

const META = "@patchwork";

const DEFAULT_INDENT = "  ";

// The value to store as a JSON document for a file, or undefined when it
// should stay a plain file doc. With a `datatype` rule, any file holding a
// JSON object qualifies and gets the rule's metadata. Without one, git sync
// keeps it a file (pushwork's `jsonDocuments` setting is off by default, and
// git sync has no checkout to set it in).
export function jsonDocumentOf(bytes: Uint8Array, datatype?: Datatype): JsonObject | undefined {
  if (!datatype) return undefined;
  const value = parseJsonObject(bytes);
  if (!value) return undefined;
  return documentValueOf(value, undefined, datatype);
}

// A file doc: `{ content }`, with no `@patchwork` or a `file` one.
export function isFileEntryDoc(doc: unknown): boolean {
  if (!isRecord(doc) || !("content" in doc)) return false;
  const meta = doc[META];
  return meta === undefined || (isRecord(meta) && meta.type === "file");
}

// A JSON document's value as it appears in the file: without its
// `@patchwork` field when the path's datatype strips it.
export function fileValueOf(doc: unknown, stripMetadata: boolean): JsonObject {
  const full = jsonValueOf(doc);
  if (!stripMetadata || !hasOwn(full, META)) return full;
  const { [META]: _meta, ...value } = full;
  return value;
}

export function withMeta(value: JsonObject, meta: JsonValue | undefined): JsonObject {
  return meta === undefined ? value : { ...value, [META]: meta };
}

// The document value a file stands for. A file without a `@patchwork` field
// keeps `baseMeta` (the document's), so neither a stripped file nor a tool
// that drops the field erases it. A `datatype` rule's type and import URL
// override whatever the metadata says.
export function documentValueOf(
  disk: JsonObject,
  baseMeta: JsonValue | undefined,
  datatype?: Datatype,
): JsonObject {
  const { [META]: own, ...rest } = disk;
  const meta = hasOwn(disk, META) ? own : baseMeta;
  return withMeta(rest, datatype ? datatypeMeta(datatype, meta) : meta);
}

// The `@patchwork` field for a document of `datatype`, keeping every other
// field of `previous`. An import URL pinned to heads is split like Patchwork
// does: `suggestedImportUrl` without heads, `frozenImportUrl` with them.
function datatypeMeta(datatype: Datatype, previous: JsonValue | undefined): JsonObject {
  const meta: JsonObject = isJsonObject(previous) ? { ...previous } : {};
  meta.type = datatype.type;
  if (datatype.importUrl === undefined) return meta;
  delete meta.frozenImportUrl;
  const url = datatype.importUrl;
  if (isValidAutomergeUrl(url) && parseAutomergeUrl(url).heads !== undefined) {
    meta.suggestedImportUrl = stringifyAutomergeUrl({
      documentId: parseAutomergeUrl(url).documentId,
    });
    meta.frozenImportUrl = url;
  } else {
    meta.suggestedImportUrl = url;
  }
  return meta;
}

// The folder-link `type` for a JSON document: its own `@patchwork.type`, so
// Patchwork opens it with the matching tool.
export function jsonLinkType(doc: unknown): string | undefined {
  if (!isRecord(doc)) return undefined;
  const meta = doc[META];
  if (!isRecord(meta)) return undefined;
  const type = meta.type;
  return typeof type === "string" && !RESERVED_TYPES.has(type) ? type : undefined;
}

// Mutate `doc` (inside a change callback) until its JSON value equals
// `target`, touching only what differs, so concurrent edits to different keys
// merge.
export function patchJson(doc: JsonObject, target: JsonObject): void {
  patchObject(doc as unknown as Container, jsonValueOf(doc), target);
}

// Serialize `value`. With `template` (the file as it is now), its
// indentation, line endings, trailing newline and key order are reused, so a
// rewrite changes only the lines whose values changed.
export function formatJson(value: JsonObject, template?: Uint8Array): Uint8Array {
  const layout = template ? layoutOf(template) : undefined;
  const ordered = layout?.value ? orderLike(value, layout.value) : value;
  const indent = layout ? layout.indent : DEFAULT_INDENT;
  let text = JSON.stringify(ordered, null, indent);
  if (layout ? layout.trailingNewline : true) text += "\n";
  if (layout?.crlf) text = text.replace(/\n/g, "\r\n");
  return new TextEncoder().encode(text);
}

export function parseJsonObject(bytes: Uint8Array): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (isJsonObject(a)) {
    if (!isJsonObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => hasOwn(b, k) && jsonEquals(a[k], b[k]));
  }
  return false;
}

// The plain JSON value of an Automerge doc (or a proxy inside a change):
// text becomes strings, counters numbers, dates ISO strings.
export function jsonValueOf(doc: unknown): JsonObject {
  return JSON.parse(JSON.stringify(doc ?? {})) as JsonObject;
}

type Container = Record<string | number, unknown>;

function patchObject(node: Container, current: JsonObject, next: JsonObject): void {
  for (const key of Object.keys(current)) {
    if (!hasOwn(next, key)) delete node[key];
  }
  for (const [key, value] of Object.entries(next)) {
    const existing = hasOwn(current, key) ? current[key] : undefined;
    patchSlot(node, key, existing, value);
  }
}

function patchArray(node: unknown[], current: JsonValue[], next: JsonValue[]): void {
  let start = 0;
  while (start < current.length && start < next.length && jsonEquals(current[start], next[start])) {
    start++;
  }
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (
    currentEnd > start &&
    nextEnd > start &&
    jsonEquals(current[currentEnd - 1], next[nextEnd - 1])
  ) {
    currentEnd--;
    nextEnd--;
  }
  const paired = Math.min(currentEnd - start, nextEnd - start);
  for (let i = start; i < start + paired; i++) {
    patchSlot(node as unknown as Container, i, current[i], next[i]);
  }
  const at = start + paired;
  if (currentEnd > at) node.splice(at, currentEnd - at);
  else if (nextEnd > at) node.splice(at, 0, ...next.slice(at, nextEnd));
}

function patchSlot(
  parent: Container,
  key: string | number,
  current: JsonValue | undefined,
  next: JsonValue,
): void {
  if (current !== undefined && jsonEquals(current, next)) return;
  const live = parent[key];
  if (isJsonObject(current) && isJsonObject(next) && isRecord(live)) {
    patchObject(live as Container, current, next);
  } else if (Array.isArray(current) && Array.isArray(next) && Array.isArray(live)) {
    patchArray(live, current, next);
  } else if (typeof live === "string" && typeof next === "string" && !String(key).includes("/")) {
    // Automerge joins updateText's path with "/", so a key containing one
    // can't be addressed; such strings (e.g. Jupyter's "image/png") are
    // replaced whole.
    Automerge.updateText(parent as Automerge.Doc<unknown>, [key], next);
  } else {
    parent[key] = next;
  }
}

type Layout = {
  value?: JsonValue;
  indent: string;
  trailingNewline: boolean;
  crlf: boolean;
};

function layoutOf(template: Uint8Array): Layout | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(template);
  } catch {
    return undefined;
  }
  let value: JsonValue | undefined;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    value = undefined;
  }
  const body = text.trimEnd();
  return {
    value,
    indent: body.includes("\n") ? (/\n([ \t]+)\S/.exec(body)?.[1] ?? "") : "",
    trailingNewline: text.endsWith("\n"),
    crlf: text.includes("\r\n"),
  };
}

function orderLike(value: JsonValue, template: JsonValue | undefined): JsonValue {
  if (Array.isArray(value)) {
    const items = Array.isArray(template) ? template : [];
    return value.map((v, i) => orderLike(v, items[i]));
  }
  if (!isJsonObject(value)) return value;
  const shape = isJsonObject(template) ? template : {};
  const out: JsonObject = {};
  for (const key of Object.keys(shape)) {
    if (hasOwn(value, key)) out[key] = orderLike(value[key], shape[key]);
  }
  for (const key of Object.keys(value)) {
    if (!hasOwn(out, key)) out[key] = orderLike(value[key], undefined);
  }
  return out;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
