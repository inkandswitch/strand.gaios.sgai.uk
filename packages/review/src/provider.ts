import { isValidAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo/slim";
import { accept, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

// A draft or a merge by its url, or null for main.
export type Overlay = AutomergeUrl | null;

// A point in an overlay's history; null for its working copy.
export type At = string | null;

// What's compared: two versions, A the overlay checked out (at `aAt`) and B
// the one it's compared with (at `bAt`); or a merge (A, after) against its
// target (B, before). Two points in one overlay's history are A and B of the
// same overlay. Null while nothing is compared.
export type Comparison =
  | { kind: "compare"; a: Overlay; b: Overlay; aAt: At; bAt: At }
  | {
      kind: "merge";
      a: AutomergeUrl;
      b: Overlay;
      source: Overlay;
      target: Overlay;
      published: boolean;
    }
  | null;

// The parts of the overlay provider's `overlays` read here.
type OverlaysState = {
  checkedOut: Overlay;
  at?: At;
  status: "loading" | "ready" | "unavailable";
  drafts: { url: AutomergeUrl }[];
  merges: { url: AutomergeUrl; source: Overlay; target: Overlay; published: boolean }[];
};

// Mounts inside an overlay provider and holds which two versions are
// compared. Answers:
//   - `compare` → Comparison, pushed on every change
//   - `compare:set { overlay, at? }` → compares with `overlay` (null for
//     main) as it was at `at` (its working copy when that's unset), answers
//     true; null while a merge is checked out
//   - `compare:clear` → compares with nothing, answers true; null while a
//     merge is checked out
// Starts out comparing with the `against` attribute: an overlay's url, or
// "main", at the `against-at` attribute's point if that's set. Comparing
// with the version checked out, or with an overlay that went away, compares
// with nothing. A merge checked out is always shown against its
// target, as a merge; what was set comes back once it isn't.
export function CompareProvider(element: HTMLElement): () => void {
  let against = attribute(element);
  let againstAt: At = element.getAttribute("against-at") || null;
  let overlays: OverlaysState | undefined;
  let listed = new Set<AutomergeUrl>();
  let current: Comparison = null;
  let settled = false;
  const subscribers = new Set<(value: Comparison) => void>();

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector as { type: string; overlay?: unknown; at?: unknown };
    switch (selector.type) {
      case "compare":
        accept<Comparison>(event, (respond) => {
          // Until the overlays are in, `against` may still be dropped.
          if (settled) respond(current);
          subscribers.add(respond);
          return () => subscribers.delete(respond);
        });
        return;

      case "compare:set": {
        const overlay = selector.overlay;
        const at = selector.at ?? null;

        const valid =
          (overlay === null || isValidAutomergeUrl(overlay)) &&
          (at === null || (typeof at === "string" && at !== ""));
        accept<true | null>(event, (respond) => {
          if (!valid || current?.kind === "merge") return respond(null);
          against = overlay as Overlay;
          againstAt = at as At;
          update();
          respond(true);
        });
        return;
      }

      case "compare:clear":
        accept<true | null>(event, (respond) => {
          if (current?.kind === "merge") return respond(null);
          against = undefined;
          againstAt = null;
          update();
          respond(true);
        });
        return;
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  const stop = subscribe<OverlaysState>(element, { type: "overlays" }, (state) => {
    const urls = new Set([...state.drafts, ...state.merges].map((entry) => entry.url));
    if (against && listed.has(against) && !urls.has(against)) {
      against = undefined;
      againstAt = null;
    }
    listed = urls;
    overlays = state;
    update();
  });

  return () => {
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    stop();
    subscribers.clear();
  };

  function update() {
    if (!overlays || overlays.status !== "ready") return;
    const at = overlays.at ?? null;
    if (against !== undefined && against === overlays.checkedOut && againstAt === at) {
      against = undefined;
      againstAt = null;
    }
    const merge = overlays.merges.find((entry) => entry.url === overlays!.checkedOut);
    const next: Comparison = merge
      ? {
          kind: "merge",
          a: merge.url,
          b: merge.target,
          source: merge.source,
          target: merge.target,
          published: merge.published,
        }
      : against === undefined
        ? null
        : { kind: "compare", a: overlays.checkedOut, b: against, aAt: at, bAt: againstAt };
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    if (settled && !changed) return;
    settled = true;
    current = next;
    for (const respond of subscribers) respond(current);
  }
}

// The `against` attribute: an overlay's url, "main", or nothing.
function attribute(element: HTMLElement): Overlay | undefined {
  const raw = element.getAttribute("against");
  if (raw === "main") return null;
  return raw && isValidAutomergeUrl(raw) ? raw : undefined;
}
