import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo/slim";
import { getRegistry, type PluginDescription } from "@inkandswitch/patchwork-plugins";
import { docUrlOf, isWholeDocument } from "./comments";

/**
 * `patchwork:ref-view`: draws what a comment's refs point at, for the thread
 * cards in the sidebar, whether or not the document is open. One per
 * datatype, picked by the commented document's `@patchwork.type`.
 */
export type RefViewDescription = PluginDescription & {
  supportedDatatypes: string[];
};

export type RefView = {
  /**
   * One line naming the target. `refs` are the thread's refs into `doc`,
   * resolved. null: the target is gone (shown as removed); false: hide the
   * thread altogether.
   */
  describe(refs: DocHandle<unknown>[], doc: DocHandle<unknown>): string | null | false;
  /** Draw a small preview (about 44×28) into `element`; returns a cleanup. */
  thumbnail?(
    refs: DocHandle<unknown>[],
    doc: DocHandle<unknown>,
    element: HTMLElement
  ): () => void;
};

export const REF_VIEW = "patchwork:ref-view";

const cache = new Map<string, Promise<RefView | undefined>>();
let listening = false;

/** The ref view registered for documents of `type`, if any. */
export function refViewFor(type: string | undefined): Promise<RefView | undefined> {
  if (!type) return Promise.resolve(undefined);
  const registry = getRegistry<RefViewDescription>(REF_VIEW as never);
  if (!listening) {
    listening = true;
    registry.on("changed", () => cache.clear());
  }
  let found = cache.get(type);
  if (!found) {
    const plugin = registry.filter((p) =>
      (p as RefViewDescription).supportedDatatypes?.includes(type)
    )[0];
    found = plugin
      ? registry.load(plugin.id).then(
          (loaded) => loaded?.module as RefView | undefined,
          (error) => {
            console.error(`comments: couldn't load ref view ${plugin.id}`, error);
            return undefined;
          }
        )
      : Promise.resolve(undefined);
    cache.set(type, found);
  }
  return found;
}

export type Described = {
  /** what the thread is about, in a few words */
  label: string;
  /** the target is gone */
  removed: boolean;
  /** the thread shouldn't be listed at all */
  hidden: boolean;
  view?: RefView;
  refs: DocHandle<unknown>[];
  doc?: DocHandle<unknown>;
};

const WHOLE: Omit<Described, "refs"> = {
  label: "Whole document",
  removed: false,
  hidden: false,
};

/**
 * Describe what `refs` point at: through the document's ref view when it has
 * one, else a quote for a text range, else a generic label.
 */
export async function describeRefs(repo: Repo, refs: AutomergeUrl[]): Promise<Described> {
  const parts = refs.filter((ref) => !isWholeDocument(ref));
  if (parts.length === 0) return { ...WHOLE, refs: [] };
  const doc = await repo.find(docUrlOf(parts[0])).catch(() => undefined);
  const handles = (
    await Promise.all(parts.map((ref) => repo.find(ref).catch(() => undefined)))
  ).filter((h): h is DocHandle<unknown> => Boolean(h));
  if (!doc) return { label: "Removed", removed: true, hidden: false, refs: handles };

  const type = (doc.doc() as { "@patchwork"?: { type?: string } } | undefined)?.[
    "@patchwork"
  ]?.type;
  const view = await refViewFor(type);
  if (view) {
    try {
      const said = view.describe(handles, doc);
      if (said === false) return { label: "", removed: false, hidden: true, refs: handles, doc };
      if (said === null)
        return { label: "Removed", removed: true, hidden: false, view, refs: handles, doc };
      return { label: said, removed: false, hidden: false, view, refs: handles, doc };
    } catch (error) {
      console.error("comments: ref view failed to describe", error);
    }
  }
  return { ...fallback(handles), refs: handles, doc };
}

/** Without a ref view: quote a text range, or name the part generically. */
export function fallback(handles: DocHandle<unknown>[]): Omit<Described, "refs"> {
  if (handles.length === 0) return { label: "Removed", removed: true, hidden: false };
  const first = handles[0];
  const range = safe(() => first.rangePositions());
  if (range) {
    if (range[0] === range[1]) return { label: "Removed", removed: true, hidden: false };
    const text = safe(() => first.doc());
    if (typeof text === "string") return { label: quote(text), removed: false, hidden: false };
  }
  if (safe(() => first.doc()) === undefined)
    return { label: "Removed", removed: true, hidden: false };
  return {
    label: handles.length > 1 ? `${handles.length} parts` : "Part of the document",
    removed: false,
    hidden: false,
  };
}

export function quote(text: string, max = 60) {
  const flat = text.trim().replace(/\s+/g, " ");
  return `“${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}”`;
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
