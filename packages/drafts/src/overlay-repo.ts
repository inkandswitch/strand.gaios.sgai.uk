import { Automerge } from "@automerge/automerge-repo/slim";
import {
  Repo,
  encodeHeads,
  interpretAsDocumentId,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type DocumentProgress,
  type QueryState,
  type UrlHeads,
} from "@automerge/automerge-repo/slim";

import { canonicalUrl, watchDocTree, type DocTree } from "./children.js";
import { cloneAt, docAt, draftVersion, install, type Version } from "./draft-clones.js";
import { headsAt, metasOf, type Point } from "./history.js";
import { OverlayHandle, forwardingProxy } from "./overlay-handle.js";
import type {
  CloneEntry,
  DraftDoc,
  HandleDescriptor,
  Member,
  MergeDoc,
  Overlay,
} from "./overlay-types.js";
import { isDraftDoc, isMergeDoc } from "./overlay-types.js";

/** What an `OverlayRepo` reads through. Null is main. */
export type Checkout =
  | null
  | { kind: "draft"; url: AutomergeUrl; handle: DocHandle<DraftDoc> }
  | {
      kind: "merge";
      url: AutomergeUrl;
      handle: DocHandle<MergeDoc>;
      // The drafts it merges, null for main.
      source: DocHandle<DraftDoc> | null;
      target: DocHandle<DraftDoc> | null;
    };

/** The overlay at `url` (null for main), loaded, to check out. */
export async function openOverlay(base: Repo, url: Overlay): Promise<Checkout> {
  if (!url) return null;
  const handle = await base.find<DraftDoc | MergeDoc>(url);
  const doc = handle.doc();
  if (isDraftDoc(doc)) return { kind: "draft", url, handle: handle as DocHandle<DraftDoc> };
  if (!isMergeDoc(doc)) throw new Error(`[drafts] ${url} is neither a draft nor a merge`);
  const draft = (input: AutomergeUrl | null) =>
    input ? base.find<DraftDoc>(input) : Promise.resolve(null);
  const [source, target] = await Promise.all([draft(doc.source), draft(doc.target)]);
  return { kind: "merge", url, handle: handle as DocHandle<MergeDoc>, source, target };
}

// The members an overlay repo changes. Everything else (clone, delete, flush,
// the event emitter, ...) forwards to the base repo.
const OWNED: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  "base",
  "overlay",
  "at",
  "handles",
  "find",
  "findWithProgress",
  "create",
  "create2",
  "checkout",
  "setRoot",
  "members",
  "onMembers",
  "descriptorFor",
  "onRemap",
  "dispose",
]);

type Entry = {
  presented: AutomergeUrl;
  root: AutomergeUrl;
  segments: unknown[];
  heads: UrlHeads | undefined;
  handle: OverlayHandle<unknown>;
  // What currently backs it, and a counter so only the latest re-point of an
  // entry commits.
  applied: string;
  seq: number;
};

/**
 * The repo an overlay provider hands everything beneath it. `find` returns
 * handles that keep the url they were asked for but read and write the
 * checked-out overlay:
 *
 * - On main, the member itself.
 * - On a draft, the draft's clone of the member once it has one; before
 *   that, the version the fork recorded (see `CloneEntry`), or the member
 *   itself for members the fork didn't know about.
 * - On a merge, the merge's clone once it has one; before that, its source's
 *   and target's versions merged in memory. Either way it follows both as
 *   they change.
 *
 * The first write to a member clones it into the overlay and records the
 * clone in its `clones`, so an overlay only owns the members it changed.
 * Only members fork: ones the overlay already has an entry for, and ones in
 * the tree under the root (`setRoot`). Writes to anything else (accounts,
 * contacts, ...) land on the document itself. With no root every document
 * forks.
 *
 * Checked out at a point in a draft's or main's history, every member reads
 * as it was then, read-only (see `headsAt`), and nothing is cloned.
 *
 * `checkout` re-points every live handle in place, so switching overlays
 * remounts nothing. Finds wait for `ready`, so a document opened before the
 * first checkout is known doesn't show main first.
 */
export class OverlayRepo {
  readonly base: Repo;
  readonly #ready: Promise<unknown>;
  #checkout: Checkout = null;
  #at: Point | null = null;
  readonly #entries = new Map<AutomergeUrl, Entry>();
  readonly #resolving = new Map<AutomergeUrl, Promise<DocHandle<unknown>>>();
  #root: AutomergeUrl | null = null;
  #tree: DocTree | null = null;
  // Members merged in memory, or cloned, on the checked-out merge.
  #merged = new Map<AutomergeUrl, MergedMember>();
  // Documents created while a draft was checked out, by draft: they're the
  // draft's own, so they become its clone instead of being cloned.
  readonly #created = new Map<AutomergeUrl, AutomergeUrl>();
  readonly #remapListeners = new Set<() => void>();
  readonly #memberListeners = new Set<() => void>();
  #stopWatching = () => {};
  #disposed = false;

  constructor(
    base: Repo,
    options: { ready?: Promise<unknown> } = {}
  ) {
    this.base = base;
    this.#ready = (options.ready ?? Promise.resolve()).catch(() => {});
    return forwardingProxy<OverlayRepo>(this, base, OWNED);
  }

  /** The checked-out overlay, null for main. */
  get overlay(): Overlay {
    return this.#checkout?.url ?? null;
  }

  /** The point in its history it's checked out at; null for the working copy. */
  get at(): Point | null {
    return this.#at;
  }

  get handles(): Record<DocumentId, DocHandle<unknown>> {
    const out = { ...this.base.handles };
    for (const entry of this.#entries.values()) {
      if (entry.segments.length || entry.heads) continue;
      out[entry.handle.documentId] = entry.handle as unknown as DocHandle<unknown>;
    }
    return out;
  }

  find<T>(id: AnyDocumentId): Promise<DocHandle<T>> {
    const presented = presentedUrlOf(id);
    const pending = this.#resolving.get(presented);
    if (pending) return pending as Promise<DocHandle<T>>;
    const promise = this.#open(presented);
    // A failed find is usually a document that hasn't synced yet; let the
    // next find try again rather than pinning it to this rejection.
    promise.catch(() => {
      if (this.#resolving.get(presented) === promise) this.#resolving.delete(presented);
    });
    this.#resolving.set(presented, promise);
    return promise as Promise<DocHandle<T>>;
  }

  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T> {
    const promise = this.find<T>(id);
    let state: QueryState<T> = { state: "loading", sources: {} };
    const callbacks = new Set<(state: QueryState<T>) => void>();
    const settle = (next: QueryState<T>) => {
      state = next;
      for (const callback of [...callbacks]) callback(state);
    };
    promise.then(
      (handle) => settle({ state: "ready", handle, sources: {} }),
      (error: Error) => settle({ state: "failed", error, sources: {} })
    );
    return {
      documentId: parseAutomergeUrl(presentedUrlOf(id)).documentId,
      peek: () => state,
      subscribe(callback) {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      whenReady: () => promise,
      get state() {
        return state.state;
      },
      get progress() {
        return undefined;
      },
      get error() {
        return state.state === "failed" ? state.error : undefined;
      },
    } as DocumentProgress<T>;
  }

  create<T>(initialValue?: T): DocHandle<T> {
    const handle = this.base.create<T>(initialValue);
    this.#noteCreated(handle.url);
    return handle;
  }

  async create2<T>(initialValue?: T): Promise<DocHandle<T>> {
    const handle = await this.base.create2<T>(initialValue);
    this.#noteCreated(handle.url);
    return handle;
  }

  /**
   * Re-point every live handle at `next`, as it was at `at` if that's set
   * (not for a merge); resolves once they all have.
   */
  checkout(next: Checkout, at: Point | null = null): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const previous = this.#checkout;
    this.#checkout = next;
    this.#at = next?.kind === "merge" ? null : at;
    if (previous?.url !== next?.url) {
      this.#stopWatching();
      this.#stopWatching = watch(
        [next?.handle, next?.kind === "merge" ? next.source : null, next?.kind === "merge" ? next.target : null],
        this.#onOverlayChange
      );
      for (const member of this.#merged.values()) member.dispose();
      this.#merged = new Map();
    }
    const repointed = this.#repointAll();
    this.#tree?.refresh();
    this.#notifyRemap();
    return repointed;
  }

  /** The documents whose tree makes up the overlay. */
  setRoot(root: AutomergeUrl | null): void {
    if (this.#disposed) return;
    const next = root ? canonicalUrl(root) : null;
    if (next === this.#root) return;
    this.#root = next;
    this.#tree?.dispose();
    this.#tree = next
      ? watchDocTree(next, (url) => this.find(url), () => this.#notifyMembers())
      : null;
  }

  /** Every member as the checked-out overlay has it, once they're all known. */
  async members(): Promise<Member[]> {
    await this.#ready;
    if (!this.#tree) return [];
    await this.#tree.settled();
    return this.#tree.members();
  }

  /** Calls `listener` whenever the members, or any of their heads, move. */
  onMembers(listener: () => void): () => void {
    this.#memberListeners.add(listener);
    return () => this.#memberListeners.delete(listener);
  }

  /**
   * What a view resolving `url` through `repo:handle-descriptor` should read.
   * Such a view writes to whatever it's handed, with no chance to clone
   * first, so a member the overlay owns is cloned now. Documents outside the
   * overlay's tree, and everything on main, read as they are.
   */
  async descriptorFor(url: AutomergeUrl): Promise<HandleDescriptor> {
    await this.#ready;
    await this.#tree?.settled();
    const root = canonicalUrl(url);
    await this.find(root);
    const entry = this.#entries.get(root);
    // A point in history, pinned: read where it is, as it was.
    if (this.#at && entry) return { url: root, cloneUrl: entry.applied as AutomergeUrl };
    if (this.#checkout && this.#belongs(root)) this.#cloneOnWrite(root);
    const backing = entry?.handle.backingHandle.url;
    return !backing || canonicalUrl(backing) === root
      ? { url: root }
      : { url: root, cloneUrl: canonicalUrl(backing) };
  }

  /** Calls `listener` whenever what `descriptorFor` answers may have changed. */
  onRemap(listener: () => void): () => void {
    this.#remapListeners.add(listener);
    return () => this.#remapListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tree?.dispose();
    this.#tree = null;
    this.#stopWatching();
    for (const member of this.#merged.values()) member.dispose();
    this.#merged.clear();
    for (const entry of this.#entries.values()) entry.handle.dispose();
    this.#entries.clear();
    this.#resolving.clear();
    this.#remapListeners.clear();
    this.#memberListeners.clear();
  }

  // Someone else may have cloned a member into the overlay, or its inputs
  // may have moved.
  #onOverlayChange = () => {
    const adopted = [...this.#merged.values()].map((member) => member.adoptRecorded());
    void Promise.all(adopted).then(() => this.#repointAll());
    this.#tree?.refresh();
    this.#notifyRemap();
  };

  #notifyRemap(): void {
    for (const listener of [...this.#remapListeners]) listener();
  }

  #notifyMembers(): void {
    for (const listener of [...this.#memberListeners]) listener();
  }

  #noteCreated(url: AutomergeUrl): void {
    const checkout = this.#checkout;
    if (checkout?.kind === "draft") this.#created.set(canonicalUrl(url), checkout.url);
  }

  async #open(presented: AutomergeUrl): Promise<DocHandle<unknown>> {
    await this.#ready;
    const { documentId, segments, heads } = parseAutomergeUrl(presented);
    const root = stringifyAutomergeUrl({ documentId });
    const backing = await this.#backing(root, segments ?? [], heads);
    if (this.#disposed) throw new Error(`[drafts] repo disposed: ${presented}`);

    const handle = new OverlayHandle<unknown>({
      presentedUrl: presented,
      backing: backing.handle,
      beforeWrite: heads ? undefined : () => this.#cloneOnWrite(root),
      writable: heads ? undefined : () => this.#isSnapshot(root),
    });
    const entry: Entry = {
      presented,
      root,
      segments: segments ?? [],
      heads,
      handle,
      applied: backing.key,
      seq: 0,
    };
    this.#entries.set(presented, entry);
    // The checkout may have moved while the backing loaded.
    void this.#repoint(entry);
    return handle as unknown as DocHandle<unknown>;
  }

  // What reads `root` (at `segments`, pinned to `heads`) on the checkout, and
  // a key naming it, to tell whether it moved.
  async #backing(
    root: AutomergeUrl,
    segments: unknown[],
    heads: UrlHeads | undefined
  ): Promise<{ key: string; handle: DocHandle<unknown> }> {
    const checkout = this.#checkout;
    if (checkout?.kind === "merge" && this.#belongs(root)) {
      const member = this.#mergedMember(checkout, root);
      await member.ready;
      let handle = member.current!;
      if (heads) handle = handle.view(heads);
      if (segments.length) handle = subOf(handle, segments);
      return { key: handle.url, handle };
    }
    const at = this.#at;
    if (at && !heads) {
      const version = this.#draftVersionOf(root);
      const source = await this.base.find<unknown>(version.url);
      const pinned = pinnedHeads(source.doc() as Automerge.Doc<unknown>, at, version.heads);
      const url = this.#draftBackingUrl(root, segments, pinned);
      // A view of the handle already loaded, not a find of `url`: the heads
      // come from this very document, and a find with heads checks them with
      // `hasHeads`, which hashes the document's changes (tens of milliseconds
      // a document, every one).
      let handle = source.view(pinned);
      if (segments.length) handle = subOf(handle, segments);
      return { key: url, handle };
    }
    const url = this.#draftBackingUrl(root, segments, heads);
    return { key: url, handle: await this.base.find<unknown>(url) };
  }

  #draftVersionOf(root: AutomergeUrl): Version {
    const checkout = this.#checkout;
    return draftVersion(checkout?.kind === "draft" ? checkout.handle.doc() : null, root);
  }

  #draftBackingUrl(root: AutomergeUrl, segments: unknown[], heads: UrlHeads | undefined): AutomergeUrl {
    const version = this.#draftVersionOf(root);
    return stringifyAutomergeUrl({
      documentId: parseAutomergeUrl(version.url).documentId,
      segments: segments.length ? (segments as never) : undefined,
      heads: heads ?? version.heads,
    });
  }

  #mergedMember(checkout: Extract<Checkout, { kind: "merge" }>, root: AutomergeUrl): MergedMember {
    let member = this.#merged.get(root);
    if (!member) {
      member = new MergedMember(this.base, checkout, root);
      this.#merged.set(root, member);
      // A member that fails to load is tried again on the next find.
      member.ready.catch(() => {
        if (this.#merged.get(root) === member) this.#merged.delete(root);
      });
    }
    return member;
  }

  async #repointAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((e) => this.#repoint(e)));
  }

  async #repoint(entry: Entry): Promise<void> {
    const seq = ++entry.seq;
    try {
      const target = await this.#backing(entry.root, entry.segments, entry.heads);
      if (seq !== entry.seq || this.#disposed || target.key === entry.applied) return;
      entry.applied = target.key;
      entry.handle.swapBackingDocHandle(target.handle);
    } catch (err) {
      console.error(`[drafts] failed to re-point ${entry.presented}:`, err);
    }
  }

  // Runs synchronously inside the write, so the write itself lands on the
  // clone. The clone is made at the version the handles were reading, so
  // they move onto it quietly.
  #cloneOnWrite(root: AutomergeUrl): void {
    const checkout = this.#checkout;
    if (!checkout || this.#at) return;
    if (checkout.kind === "merge") {
      if (!this.#belongs(root)) return;
      const member = this.#merged.get(root);
      const clone = member?.persist();
      if (clone) this.#moveOnto(root, clone, { sameContent: true });
      return;
    }

    const draft = checkout.handle;
    const recorded = draft.doc()?.clones?.[root];
    if (recorded?.cloneUrl) {
      // Recorded but not re-pointed yet: move now if the clone is loaded, so
      // the write can't land on the original.
      const clone = this.#loaded(recorded.cloneUrl);
      if (clone) this.#moveOnto(root, clone, { sameContent: false });
      return;
    }
    if (!recorded && !this.#belongs(root)) return;

    if (!recorded && this.#created.get(root) === checkout.url) {
      draft.change((d) => {
        d.clones[root] = { cloneUrl: root, clonedAt: encodeHeads([]) };
      });
      return;
    }

    const clone = this.#forkFor(root, recorded);
    if (!clone) return;
    this.#moveOnto(root, clone.handle, { sameContent: true });
    const cloneUrl = canonicalUrl(clone.handle.url);
    draft.change((d) => {
      const entry = d.clones[root];
      if (entry) entry.cloneUrl = cloneUrl;
      else d.clones[root] = { cloneUrl, clonedAt: clone.clonedAt };
    });
  }

  // A clone of `root` at the version the draft reads it: the recorded fork
  // point, or the member as it is now.
  #forkFor(
    root: AutomergeUrl,
    recorded: CloneEntry | undefined
  ): { handle: DocHandle<unknown>; clonedAt: UrlHeads } | null {
    const source = this.#loaded(recorded?.source ?? root);
    if (!source) return null;
    const clonedAt = recorded?.clonedAt ?? source.heads();
    try {
      return { handle: cloneAt(this.base, source, clonedAt), clonedAt };
    } catch (err) {
      console.error(`[drafts] failed to fork ${root}:`, err);
      return null;
    }
  }

  // Read from a fork point the next write clones, rather than pinned.
  #isSnapshot(root: AutomergeUrl): boolean {
    const checkout = this.#checkout;
    if (checkout?.kind !== "draft" || this.#at) return false;
    const entry = checkout.handle.doc()?.clones?.[root];
    return !!entry && !entry.cloneUrl;
  }

  // Unknown while the tree is still being walked; erring on forking is safe.
  #belongs(root: AutomergeUrl): boolean {
    const tree = this.#tree;
    return !tree || !tree.isSettled() || tree.has(root);
  }

  #loaded(url: AutomergeUrl): DocHandle<unknown> | null {
    const handle = this.base.handles[parseAutomergeUrl(url).documentId];
    return handle?.isReady() ? handle : null;
  }

  #moveOnto(
    root: AutomergeUrl,
    clone: DocHandle<unknown>,
    { sameContent }: { sameContent: boolean }
  ): void {
    for (const entry of this.#entries.values()) {
      if (entry.root !== root || entry.heads) continue;
      const backing = entry.segments.length ? subOf(clone, entry.segments) : clone;
      if (backing.url === entry.applied) continue;
      entry.seq++;
      entry.applied = backing.url;
      entry.handle.swapBackingDocHandle(backing, { sameContent });
    }
  }
}

/**
 * One member of a checked-out merge: its source's and target's versions
 * merged together, kept up to date as either changes. Until the member's
 * first write that's a document in memory only, in a repo of its own that
 * neither stores nor syncs; `persist` makes it the merge's clone, which then
 * keeps taking in both inputs' changes.
 */
class MergedMember {
  readonly ready: Promise<void>;
  readonly base: Repo;
  readonly checkout: Extract<Checkout, { kind: "merge" }>;
  readonly root: AutomergeUrl;
  #handle: DocHandle<unknown> | null = null;
  #persisted = false;
  #inputs: Input[] = [];
  #disposed = false;
  #stop = () => {};

  constructor(base: Repo, checkout: Extract<Checkout, { kind: "merge" }>, root: AutomergeUrl) {
    this.base = base;
    this.checkout = checkout;
    this.root = root;
    this.ready = this.#start();
  }

  /** What reads the member now: in memory, or the merge's clone. */
  get current(): DocHandle<unknown> | null {
    return this.#handle;
  }

  /**
   * Makes the member the merge's own clone, if it isn't yet, and returns
   * it. Synchronous, to run inside a write.
   */
  persist(): DocHandle<unknown> | null {
    const current = this.#handle;
    if (!current || this.#persisted || this.#disposed) return null;
    const clone = install(this.base, current.doc() as Automerge.Doc<unknown>);
    const cloneUrl = canonicalUrl(clone.url);
    const clonedAt = clone.heads();
    this.checkout.handle.change((d) => {
      d.clones[this.root] = { cloneUrl, clonedAt };
    });
    this.#handle = clone;
    this.#persisted = true;
    return clone;
  }

  /**
   * Moves onto the merge's clone of the member, where one has been recorded
   * since (by another repo reading the same merge, say).
   */
  async adoptRecorded(): Promise<void> {
    await this.ready.catch(() => {});
    if (this.#persisted || this.#disposed) return;
    const recorded = this.checkout.handle.doc()?.clones?.[this.root]?.cloneUrl;
    if (!recorded) return;
    const clone = await this.base.find<unknown>(recorded);
    if (this.#persisted || this.#disposed) return;
    this.#handle = clone;
    this.#persisted = true;
    this.#takeIn();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stop();
  }

  async #start(): Promise<void> {
    const recorded = this.checkout.handle.doc()?.clones?.[this.root]?.cloneUrl;
    this.#inputs = await Promise.all([
      this.#input(() => this.checkout.target),
      this.#input(() => this.checkout.source),
    ]);
    if (recorded) {
      this.#handle = await this.base.find<unknown>(recorded);
      this.#persisted = true;
    } else {
      const [target, source] = this.#inputs.map((input) => input.doc());
      const merged = Automerge.merge(Automerge.clone(target), source);
      this.#handle = install(scratchRepo(), merged);
    }
    this.#takeIn();
    const stops = this.#inputs.map((input) => input.watch(() => this.#takeIn()));
    this.#stop = () => stops.forEach((stop) => stop());
  }

  // Both inputs' changes, merged into the member.
  #takeIn(): void {
    const handle = this.#handle;
    if (!handle || this.#disposed) return;
    for (const input of this.#inputs) {
      const doc = input.doc();
      if (Automerge.hasHeads(handle.doc() as Automerge.Doc<unknown>, Automerge.getHeads(doc))) continue;
      handle.update((current) => Automerge.merge(current as Automerge.Doc<unknown>, doc));
    }
  }

  // One input's version of the member: where its draft (null for main) reads
  // it, following the draft as it clones the member.
  async #input(draft: () => DocHandle<DraftDoc> | null): Promise<Input> {
    const versionNow = () => draftVersion(draft()?.doc(), this.root);
    let version: Version = versionNow();
    let handle = await this.base.find<unknown>(version.url);
    let pinned = version.heads ? docAt(handle, version.heads) : null;
    return {
      doc: () => pinned ?? (handle.doc() as Automerge.Doc<unknown>),
      watch: (changed) => {
        let live = true;
        const onChange = () => changed();
        const follow = async () => {
          const next = versionNow();
          if (next.url === version.url && sameVersion(next, version)) return;
          const nextHandle = await this.base.find<unknown>(next.url);
          if (!live) return;
          handle.off("change", onChange);
          version = next;
          handle = nextHandle;
          pinned = next.heads ? docAt(handle, next.heads) : null;
          handle.on("change", onChange);
          changed();
        };
        const onDraftChange = () => void follow();
        handle.on("change", onChange);
        draft()?.on("change", onDraftChange);
        return () => {
          live = false;
          handle.off("change", onChange);
          draft()?.off("change", onDraftChange);
        };
      },
    };
  }
}

type Input = {
  doc(): Automerge.Doc<unknown>;
  watch(changed: () => void): () => void;
};

function sameVersion(a: Version, b: Version): boolean {
  const ah = a.heads ?? [];
  const bh = b.heads ?? [];
  return ah.length === bh.length && ah.every((h, i) => h === bh[i]);
}

// Where merges are worked out before anything is written: a repo that
// neither stores nor syncs.
let scratch: Repo | undefined;
function scratchRepo(): Repo {
  scratch ??= new Repo({ isEphemeral: true });
  return scratch;
}

/**
 * The repo beneath any overlay. The overlays' own bookkeeping (drafts,
 * merges, the workspace) reads documents as they are, so it must never resolve
 * through an `OverlayRepo`, even from inside one.
 */
export function baseRepo(repo: Repo): Repo {
  return repo instanceof OverlayRepo ? baseRepo(repo.base) : repo;
}

function watch(handles: (DocHandle<unknown> | null | undefined)[], listener: () => void): () => void {
  const live = handles.filter((handle): handle is DocHandle<unknown> => !!handle);
  for (const handle of live) handle.on("change", listener);
  return () => {
    for (const handle of live) handle.off("change", listener);
  };
}

// Where a point in history leaves a document an overlay reads at `within`
// (or as it is): as it was then, or, made later than that, as it was made.
function pinnedHeads(doc: Automerge.Doc<unknown>, at: Point, within: UrlHeads | undefined): UrlHeads {
  const heads = headsAt(doc, at, within);
  if (heads) return heads;
  const first = metasOf(doc)[0];
  return first ? encodeHeads([first.hash]) : (within ?? encodeHeads([]));
}

function subOf(handle: DocHandle<unknown>, segments: unknown[]): DocHandle<unknown> {
  return (handle as unknown as { sub: (...s: unknown[]) => DocHandle<unknown> }).sub(...segments);
}

// A url's identity through the overlay: document, path and heads.
function presentedUrlOf(id: AnyDocumentId): AutomergeUrl {
  if (isValidAutomergeUrl(id)) {
    const { documentId, segments, heads } = parseAutomergeUrl(id);
    return stringifyAutomergeUrl({ documentId, segments, heads });
  }
  return stringifyAutomergeUrl({ documentId: interpretAsDocumentId(id) });
}
