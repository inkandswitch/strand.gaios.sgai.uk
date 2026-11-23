import { isValidAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo/slim";
import { accept, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

// A draft or a merge by its url, or null for main.
export type Overlay = AutomergeUrl | null;

// What's compared: two versions, A the overlay checked out and B the one it's
// compared with; or a merge (A, after) against its target (B, before). Null
// while nothing is compared.
export type Comparison =
  | { kind: "compare"; a: Overlay; b: Overlay }
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
  status: "loading" | "ready" | "unavailable";
  drafts: { url: AutomergeUrl }[];
  merges: { url: AutomergeUrl; source: Overlay; target: Overlay; published: boolean }[];
};

// Mounts inside an overlay provider and holds which two versions are
// compared. Answers:
//   - `compare` → Comparison, pushed on every change
//   - `compare:set { overlay }` → compares with `overlay` (null for main),
//     answers true; null while a merge is checked out
//   - `compare:clear` → compares with nothing, answers true; null while a
//     merge is checked out
// Starts out comparing with the `against` attribute: an overlay's url, or
// "main". Comparing with the checked-out overlay, or one that went away,
// compares with nothing. A merge checked out is always shown against its
// target, as a merge; what was set comes back once it isn't.
export function CompareProvider(element: HTMLElement): () => void {
  let against = attribute(element);
  let overlays: OverlaysState | undefined;
  let listed = new Set<AutomergeUrl>();
  let current: Comparison = null;
  let settled = false;
  const subscribers = new Set<(value: Comparison) => void>();

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector as { type: string; overlay?: unknown };
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
        const valid = overlay === null || isValidAutomergeUrl(overlay);
        accept<true | null>(event, (respond) => {
          if (!valid || current?.kind === "merge") return respond(null);
          against = overlay as Overlay;
          update();
          respond(true);
        });
        return;
      }

      case "compare:clear":
        accept<true | null>(event, (respond) => {
          if (current?.kind === "merge") return respond(null);
          against = undefined;
          update();
          respond(true);
        });
        return;
    }
  };
  element.addEventListener("patchwork:subscribe", onSubscribe);

  const stop = subscribe<OverlaysState>(element, { type: "overlays" }, (state) => {
    const urls = new Set([...state.drafts, ...state.merges].map((entry) => entry.url));
    if (against && listed.has(against) && !urls.has(against)) against = undefined;
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
    if (against !== undefined && against === overlays.checkedOut) against = undefined;
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
        : { kind: "compare", a: overlays.checkedOut, b: against };
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
