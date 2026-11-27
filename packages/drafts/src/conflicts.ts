// Conflicts in a merge: where a datatype says the source's and the target's
// changes don't go together, and which way each went. Nothing here is stored.
// Conflicts are found in `auto`, the two inputs merged and nothing more, and
// how each went is read off `merged`, the merge's version: the changes only
// it has are what was done in the merge.
import { Automerge } from "@automerge/automerge-repo/slim";
import {
  getRegistry,
  type Plugin,
  type PluginDescription,
} from "@inkandswitch/patchwork-plugins";

import type { Conflict, ConflictState, Place } from "./overlay-types.js";

type Doc = Automerge.Doc<unknown>;
type Path = (string | number)[];

export const MERGE_CONFLICTS_PLUGIN_TYPE = "patchwork:merge-conflicts";

// A datatype has conflicts only where a plugin installed for it reports them;
// with none, its members merge as Automerge merges them.
export type MergeConflictsDescription = PluginDescription & {
  type: typeof MERGE_CONFLICTS_PLUGIN_TYPE;
  datatypes: string[];
};

// What the plugin loads.
export type FindConflicts = (versions: Versions) => Conflict[];

export type Versions = { source: Doc; target: Doc; auto: Doc };

/** The inputs merged and nothing more. */
export function autoOf(source: Doc, target: Doc): Doc {
  return Automerge.merge(Automerge.clone(target), source);
}

/** Whether any plugin answers for the datatype of `doc`. */
export function hasConflictPlugin(doc: unknown): boolean {
  const type = datatypeOf(doc);
  return registry().filter((plugin) => answersFor(plugin, type)).length > 0;
}

/**
 * The conflicts every plugin for the member's datatype reports, in auto. A
 * datatype with none merges as Automerge merges it, with nothing reported.
 */
export async function findConflicts(versions: Versions): Promise<Conflict[]> {
  const type = datatypeOf(versions.auto);
  const plugins = registry().filter((plugin) => answersFor(plugin, type));
  if (!plugins.length) return [];
  const loaded = await registry().loadAll(plugins);
  const out: Conflict[] = [];
  const seen = new Set<string>();
  const add = (conflicts: Conflict[]) => {
    for (const conflict of conflicts) {
      const key = JSON.stringify(conflict.at);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(conflict);
    }
  };
  for (const plugin of loaded) {
    try {
      add((plugin.module as FindConflicts)(versions) ?? []);
    } catch (err) {
      console.warn(`[drafts] merge conflicts plugin ${plugin.id} failed:`, err);
    }
  }
  return out;
}

/**
 * How `conflict` went in `merged`: open until a change only the merge has
 * touches its place, made after every input change that touches it; then
 * whichever side's value is there, or both, or `edited`.
 */
export function conflictState(
  conflict: Conflict,
  versions: { source: Doc; target: Doc; merged: Doc }
): ConflictState {
  const { source, target, merged } = versions;
  const base = sharedHeads(source, target);
  const inputs = new Set(
    [...changesSince(source, base), ...changesSince(target, base)].map((change) => change.hash)
  );
  const since = changesSince(merged, base);
  const byHash = new Map(since.map((change) => [change.hash, change]));
  const touching = (change: Automerge.ChangeMetadata) => touches(merged, change, conflict.at);
  const touchedBy = since.filter((change) => inputs.has(change.hash) && touching(change));
  const resolved = since.some(
    (change) =>
      !inputs.has(change.hash) &&
      touching(change) &&
      touchedBy.every((input) => hasInHistory(change, input.hash, byHash))
  );
  if (!resolved) return "open";
  const value = valueAt(merged, conflict.at);
  if (same(value, conflict.source)) return "source";
  if (same(value, conflict.target)) return "target";
  if (conflict.both !== undefined && same(value, conflict.both)) return "both";
  return "edited";
}

/** What `doc` has at `at`: the value at its path, or the text between its cursors. */
export function valueAt(doc: Doc, at: Place): unknown {
  const value = get(doc, at.path);
  if (at.from === undefined && at.to === undefined) return plain(value);
  const text = textOf(value);
  if (text === undefined) return undefined;
  const { from, to } = rangeOf(doc, at);
  return text.slice(from, to);
}

/** Where the text of `at` is in `doc`, as offsets: from inclusive, to exclusive. */
export function rangeOf(doc: Doc, at: Place): { from: number; to: number } {
  const text = textOf(get(doc, at.path)) ?? "";
  const from = at.from === undefined ? 0 : boundary(doc, at.path, at.from, "from", text.length);
  const to = at.to === undefined ? text.length : boundary(doc, at.path, at.to, "to", text.length);
  return { from, to: Math.max(from, to) };
}

// --- How changes touch a place ------------------------------------------------

// Whether `change` (in `doc`'s history) wrote at `at`. For a text place, an
// edit counts when it's between the place's ends, both measured in `doc`.
function touches(doc: Doc, change: Automerge.ChangeMetadata, at: Place): boolean {
  let patches: Automerge.Patch[];
  try {
    patches = Automerge.diff(doc, change.deps, [change.hash]);
  } catch {
    return false;
  }
  const isText = at.from !== undefined || at.to !== undefined;
  for (const patch of patches) {
    const path = patch.path as Path;
    if (startsWith(at.path, path)) return true;
    if (!startsWith(path, at.path)) continue;
    if (!isText) return true;
    const index = path[at.path.length];
    if (typeof index !== "number") return true;
    const position = positionIn(doc, change, at.path, index);
    const range = rangeOf(doc, at);
    if (position >= range.from && position <= range.to) return true;
  }
  return false;
}

// Where `index`, in the text as `change` left it, is in `doc` now.
function positionIn(doc: Doc, change: Automerge.ChangeMetadata, path: Path, index: number): number {
  try {
    const then = Automerge.view(doc, [change.hash]);
    const length = textOf(get(then, path))?.length ?? 0;
    if (index >= length) {
      if (length === 0) return 0;
      const last = Automerge.getCursor(then, path as Automerge.Prop[], length - 1);
      return Automerge.getCursorPosition(doc, path as Automerge.Prop[], last) + 1;
    }
    const cursor = Automerge.getCursor(then, path as Automerge.Prop[], index);
    return Automerge.getCursorPosition(doc, path as Automerge.Prop[], cursor);
  } catch {
    return -1;
  }
}

// An end of a text place in offsets. A place names the characters just
// outside it, so it starts after `from` and ends before `to`.
function boundary(doc: Doc, path: Path, cursor: string, end: "from" | "to", length: number): number {
  if (cursor === "start") return 0;
  if (cursor === "end") return length;
  try {
    const position = Automerge.getCursorPosition(doc, path as Automerge.Prop[], cursor);
    return end === "from" ? position + 1 : position;
  } catch {
    return end === "from" ? 0 : length;
  }
}

function hasInHistory(
  change: Automerge.ChangeMetadata,
  hash: string,
  byHash: Map<string, Automerge.ChangeMetadata>
): boolean {
  const seen = new Set<string>();
  const stack = [...change.deps];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === hash) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const meta = byHash.get(next);
    if (meta) stack.push(...meta.deps);
  }
  return false;
}

function changesSince(doc: Doc, heads: Automerge.Heads): Automerge.ChangeMetadata[] {
  try {
    return Automerge.getChangesMetaSince(doc, heads);
  } catch {
    return [];
  }
}

/**
 * The heads of what's in the history of both `a` and `b`: the version they
 * parted from.
 */
export function sharedHeads(a: Doc, b: Doc): Automerge.Heads {
  const aHeads = Automerge.getHeads(a);
  const bHeads = Automerge.getHeads(b);
  if (Automerge.hasHeads(a, bHeads)) return bHeads;
  if (Automerge.hasHeads(b, aHeads)) return aHeads;
  const both = Automerge.merge(Automerge.clone(b), a);
  const onlyB = Automerge.getChangesMetaSince(both, aHeads);
  const only = new Set(onlyB.map((change) => change.hash));
  const heads = new Set(bHeads);
  for (const change of onlyB) for (const dep of change.deps) heads.add(dep);
  return [...heads].filter((hash) => !only.has(hash));
}

// --- Reading values -------------------------------------------------------------

function get(doc: unknown, path: Path): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

// A value as it can be sent: Automerge's own wrappers unwrapped.
function plain(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array || value instanceof Date) return value;
  if (value instanceof Automerge.ImmutableString) return value.toString();
  if (value instanceof Automerge.Counter) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

function startsWith(path: Path, prefix: Path): boolean {
  return prefix.length <= path.length && prefix.every((key, i) => path[i] === key);
}

function registry() {
  return getRegistry<MergeConflictsDescription>(MERGE_CONFLICTS_PLUGIN_TYPE);
}

function answersFor(plugin: Plugin<MergeConflictsDescription>, type: string | undefined): boolean {
  const datatypes = Array.isArray(plugin.datatypes) ? plugin.datatypes : [];
  return datatypes.includes("*") || (type !== undefined && datatypes.includes(type));
}

function datatypeOf(doc: unknown): string | undefined {
  const type = (doc as { "@patchwork"?: { type?: unknown } } | undefined)?.["@patchwork"]?.type;
  return type === undefined || type === null ? undefined : String(type);
}
