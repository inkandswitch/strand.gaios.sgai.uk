import { Automerge } from "@automerge/automerge-repo/slim";
import {
  decodeHeads,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import { sameHeads } from "./children.js";
import type { DraftDoc } from "./overlay-types.js";

// Where a draft (null for main) reads `url`: its clone once it has one, else
// the version it was forked off (`heads` set), else the member as it is.
export type Version = { url: AutomergeUrl; heads?: UrlHeads };

export function draftVersion(draft: DraftDoc | null | undefined, url: AutomergeUrl): Version {
  const entry = draft?.clones?.[url];
  if (!entry) return { url };
  if (entry.cloneUrl) return { url: entry.cloneUrl };
  return { url: entry.source ?? url, heads: entry.clonedAt };
}

// The document `handle` holds as of `heads`, as a document of its own: it can
// be merged into others, and cloned. Undefined heads is the document as it is.
export function docAt(
  handle: DocHandle<unknown>,
  heads: UrlHeads | undefined
): Automerge.Doc<unknown> {
  const doc = handle.doc() as Automerge.Doc<unknown>;
  if (!heads || sameHeads(handle.heads(), heads)) return doc;
  if (heads.length === 0) return Automerge.init<unknown>();
  return docAtVersion(doc, heads);
}

// Clone `handle`'s doc as of `to`. When `to` is where the doc already is,
// that's a plain clone.
export function cloneAt(
  repo: Repo,
  handle: DocHandle<unknown>,
  to: UrlHeads
): DocHandle<unknown> {
  if (sameHeads(handle.heads(), to)) return repo.clone(handle);
  if (to.length === 0) return repo.create<unknown>();
  return install(repo, docAtVersion(handle.doc() as Automerge.Doc<unknown>, to));
}

// A new document in `repo` holding `doc`.
export function install(repo: Repo, doc: Automerge.Doc<unknown>): DocHandle<unknown> {
  const handle = repo.create<unknown>();
  handle.update(() => Automerge.clone(doc));
  return handle;
}

// --- A document at a version -------------------------------------------------
// The obvious way — `repo.clone(handle.view(to))`, i.e. wasm `fork_at` — is
// broken upstream: on documents whose history contains certain concurrent
// merge changes (as anything synced through subduction ends up with),
// `fork_at` panics with `MissingOps` in `ChangeCollector::from_build_meta` at
// *any* heads, and the panic poisons the doc object for the rest of the session (every later call
// throws "recursive use of an object detected"). Confirmed offline against
// automerge 3.3.0-fragments.1 and .2 with a 26-change minimal repro.
//
// So the version is built without `fork_at`: collect the ancestor closure of
// the heads from the change metadata, bundle exactly those changes
// (`saveBundle`) and load them into a fresh doc (`loadIncremental`). Its
// heads are exactly `to`, and it shares history with the original, so it
// merges back cleanly.
function docAtVersion(doc: Automerge.Doc<unknown>, to: UrlHeads): Automerge.Doc<unknown> {
  const pinHeads = decodeHeads(to);
  const metas = Automerge.getChangesMetaSince(doc, []);
  const byHash = new Map(metas.map((m) => [m.hash, m]));
  const closure = new Set<string>();
  const stack = [...pinHeads];
  while (stack.length > 0) {
    const hash = stack.pop()!;
    if (closure.has(hash)) continue;
    const meta = byHash.get(hash);
    if (!meta) {
      throw new Error(`[drafts] change ${hash} is not in the doc's history metadata`);
    }
    closure.add(hash);
    stack.push(...meta.deps);
  }

  const bundle = Automerge.saveBundle(doc, [...closure]);
  const pinned = Automerge.loadIncremental(Automerge.init<unknown>(), bundle);

  const gotHeads = [...Automerge.getHeads(pinned)].sort();
  const wantHeads = [...pinHeads].sort();
  if (JSON.stringify(gotHeads) !== JSON.stringify(wantHeads)) {
    throw new Error(
      `[drafts] version heads mismatch: wanted ${wantHeads}, got ${gotHeads}`
    );
  }
  return pinned;
}
