import { Automerge } from "@automerge/automerge-repo/slim";
import {
  decodeHeads,
  encodeHeads,
  type AutomergeUrl,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import type { HistoryEntry, Overlay } from "./overlay-types.js";

// A pause between two changes longer than this starts a new entry.
export const HISTORY_GAP_SECONDS = 10 * 60;

// One change to one member, as history reads it.
export type Row = {
  hash: string;
  time: number;
  actor: string;
  member: AutomergeUrl;
  // Its place in the member's own history, to order changes made in the same
  // second (Automerge times are whole seconds).
  seq: number;
};

type Metas = Automerge.ChangeMetadata[];

// A document's change metadata, oldest first, worked out once per version.
const metaCache = new WeakMap<object, Metas>();

export function metasOf(doc: Automerge.Doc<unknown>): Metas {
  let metas = metaCache.get(doc as object);
  if (!metas) {
    metas = Automerge.getChangesMetaSince(doc, []);
    metaCache.set(doc as object, metas);
  }
  return metas;
}

/**
 * `member`'s changes in `doc` that `since` doesn't have, made no earlier than
 * `notBefore` (seconds) where that's set.
 */
export function rowsOf(
  doc: Automerge.Doc<unknown>,
  member: AutomergeUrl,
  since: UrlHeads,
  notBefore?: number
): Row[] {
  const metas = metasOf(doc);
  const old = since.length ? ancestorsOf(metas, decodeHeads(since)) : new Set<string>();
  const rows: Row[] = [];
  metas.forEach((meta, seq) => {
    if (old.has(meta.hash)) return;
    if (notBefore !== undefined && meta.time && meta.time < notBefore) return;
    rows.push({ hash: meta.hash, time: meta.time, actor: meta.actor, member, seq });
  });
  return rows;
}

/** Changes, any order, as entries, the newest first. */
export function groupRows(rows: Row[], overlay: Overlay): HistoryEntry[] {
  const sorted = [...rows].sort(
    (a, b) => b.time - a.time || b.seq - a.seq || (a.member < b.member ? 1 : -1)
  );
  const entries: HistoryEntry[] = [];
  let group: Row[] = [];
  const flush = () => {
    if (group.length) entries.push(entryOf(group, overlay));
    group = [];
  };
  for (const row of sorted) {
    const newer = group[group.length - 1];
    if (newer && newer.time - row.time > HISTORY_GAP_SECONDS) flush();
    group.push(row);
  }
  flush();
  return entries;
}

function entryOf(rows: Row[], overlay: Overlay): HistoryEntry {
  const actors: string[] = [];
  const members: AutomergeUrl[] = [];
  for (const row of rows) {
    if (!actors.includes(row.actor)) actors.push(row.actor);
    if (!members.includes(row.member)) members.push(row.member);
  }
  return {
    id: rows[0].hash,
    overlay,
    start: rows[rows.length - 1].time,
    time: rows[0].time,
    actors,
    members,
  };
}

/** A point in history: its newest change, and when that was made. */
export type Point = { hash: string; time: number };

/**
 * `doc` as it was at `point`, as heads: every change made no later than the
 * point, and the point's own change, if `doc` has it. Within `within` (the
 * version an overlay reads a member at before changing it) where that's set.
 * Undefined when `doc` has no change that early: it was made later.
 *
 * Changes are placed by the time their authors' clocks gave them, so this is
 * approximate for documents edited at the same time as the point.
 */
export function headsAt(
  doc: Automerge.Doc<unknown>,
  point: Point,
  within?: UrlHeads
): UrlHeads | undefined {
  const metas = metasOf(doc);
  const allowed = within ? ancestorsOf(metas, decodeHeads(within)) : undefined;
  const picked = new Set<string>();
  for (const meta of metas) {
    if (allowed && !allowed.has(meta.hash)) continue;
    if (meta.time <= point.time || meta.hash === point.hash) picked.add(meta.hash);
  }
  if (!picked.size) return undefined;
  // The picked changes nothing else picked depends on.
  const covered = new Set<string>();
  for (const meta of metas) {
    if (!picked.has(meta.hash)) continue;
    for (const dep of meta.deps) covered.add(dep);
  }
  return encodeHeads([...picked].filter((hash) => !covered.has(hash)));
}

/** When the change `hash` was made, if `doc` has it. */
export function timeOfChange(doc: Automerge.Doc<unknown>, hash: string): number | undefined {
  return metasOf(doc).find((meta) => meta.hash === hash)?.time;
}

/** When `doc` was made: its first change's time. */
export function createdAt(doc: Automerge.Doc<unknown>): number | undefined {
  return metasOf(doc)[0]?.time || undefined;
}

// `heads` and every change they depend on.
function ancestorsOf(metas: Metas, heads: string[]): Set<string> {
  const deps = new Map(metas.map((meta) => [meta.hash, meta.deps]));
  const out = new Set<string>();
  const stack = [...heads];
  while (stack.length) {
    const hash = stack.pop()!;
    if (out.has(hash)) continue;
    out.add(hash);
    stack.push(...(deps.get(hash) ?? []));
  }
  return out;
}
