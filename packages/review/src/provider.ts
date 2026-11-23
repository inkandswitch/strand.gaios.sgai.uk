import { isValidAutomergeUrl, type AutomergeUrl } from "@automerge/automerge-repo/slim";
import { accept, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

// A draft or a merge by its url, or null for main.
export type Overlay = AutomergeUrl | null;

// The two versions compared: A the overlay checked out, B the one it's
// compared with. Null while nothing is compared.
export type Comparison = { a: Overlay; b: Overlay } | null;

// The parts of the overlay provider's `overlays` read here.
type OverlaysState = {
  checkedOut: Overlay;
  status: "loading" | "ready" | "unavailable";
  drafts: { url: AutomergeUrl }[];
  merges: { url: AutomergeUrl }[];
};

// Mounts inside an overlay provider and holds which two versions are
// compared. Answers:
//   - `compare` → Comparison, pushed on every change
//   - `compare:set { overlay }` → compares with `overlay` (null for main),
//     answers true
//   - `compare:clear` → compares with nothing, answers true
// Starts out comparing with the `against` attribute: an overlay's url, or
// "main". Comparing with the checked-out overlay, or one that went away,
// compares with nothing.
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
          if (!valid) return respond(null);
          against = overlay as Overlay;
          update();
          respond(true);
        });
        return;
      }

      case "compare:clear":
        accept<true>(event, (respond) => {
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
    const next: Comparison =
      against === undefined ? null : { a: overlays.checkedOut, b: against };
    const changed = next?.a !== current?.a || next?.b !== current?.b || !next !== !current;
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
