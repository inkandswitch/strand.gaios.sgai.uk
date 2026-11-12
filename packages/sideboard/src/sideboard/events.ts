import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";

/**
 * Where a frame that tiles its documents should open one: beside the panel
 * last focused, as a new tab in it, or in a given group. Without one the
 * focused panel shows it instead of what it was showing.
 */
export type Placement =
  | { to: "right" | "left" | "above" | "below" | "tab" }
  | { group: string };

export type OpenDetail = OpenDocumentEventDetail & { placement?: Placement };

/**
 * The drag data type a dragged row's location travels as, so a frame can
 * open it where it's dropped.
 */
export const LOCATION_TYPE = "text/x-patchwork-location";

/**
 * A drag's data can't be read until it's dropped, only its types, so a
 * dragged row's name also travels as a type: this, then its UTF-8 bytes in
 * hex (types are lowercased on the way).
 */
export const NAME_TYPE_PREFIX = "text/x-patchwork-name-";

export function nameType(name: string) {
  const bytes = new TextEncoder().encode(name);
  return NAME_TYPE_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One of the tiling frame's groups of tabs, named after what it shows. */
export type DockGroup = { id: string; title: string };

export function createOpenEvent(detail: OpenDetail) {
  const openEvent = new CustomEvent("patchwork:open-document", {
    detail,
    bubbles: true,
    composed: true,
  });
  return openEvent;
}
