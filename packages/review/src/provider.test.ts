import { describe, expect, it } from "vitest";
import { accept, request, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import { CompareProvider, type Comparison } from "./provider.js";

const A = "automerge:2y3c9FQ2RBQTqgrEW4yW7uEDdtQ6" as const;
const B = "automerge:3U4FuN9HU7s4mxg9qRkbFsvpW19m" as const;

// An overlay provider that answers `overlays` with whatever it's given.
function overlays(initial: { checkedOut: string | null; drafts: string[] }) {
  const parent = document.createElement("div");
  let state = initial;
  const listeners = new Set<(value: unknown) => void>();
  const shape = () => ({
    checkedOut: state.checkedOut,
    status: "ready",
    drafts: state.drafts.map((url) => ({ url, name: "Draft", parent: null })),
    merges: [],
  });
  parent.addEventListener("patchwork:subscribe", ((event: SubscribeEvent) => {
    if (event.detail.selector.type !== "overlays") return;
    accept(event, (respond) => {
      const send = respond as (value: unknown) => void;
      send(shape());
      listeners.add(send);
      return () => listeners.delete(send);
    });
  }) as EventListener);
  const set = (next: typeof initial) => {
    state = next;
    for (const respond of listeners) respond(shape());
  };
  return { parent, set };
}

function mount(against?: string) {
  const host = overlays({ checkedOut: A, drafts: [A, B] });
  const element = document.createElement("div");
  if (against) element.setAttribute("against", against);
  host.parent.append(element);
  const child = document.createElement("div");
  element.append(child);
  const dispose = CompareProvider(element);
  let latest: Comparison | undefined;
  const stop = subscribe(child, { type: "compare" }, (value) => {
    latest = value as Comparison;
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { child, host, latest: () => latest, tick, done: () => (stop(), dispose()) };
}

describe("the compare provider", () => {
  it("starts from the `against` attribute, main included", async () => {
    const { latest, tick, done } = mount("main");
    await tick();
    expect(latest()).toEqual({ a: A, b: null });
    done();
  });

  it("compares with what's set until it's cleared", async () => {
    const { child, latest, tick, done } = mount();
    await tick();
    expect(latest()).toBeNull();
    expect(await request(child, { type: "compare:set", overlay: B } as never)).toBe(true);
    expect(latest()).toEqual({ a: A, b: B });
    expect(await request(child, { type: "compare:clear" } as never)).toBe(true);
    expect(latest()).toBeNull();
    done();
  });

  it("stops comparing with an overlay that's checked out or gone", async () => {
    const { child, host, latest, tick, done } = mount();
    await tick();
    await request(child, { type: "compare:set", overlay: B } as never);
    host.set({ checkedOut: B, drafts: [A, B] });
    await tick();
    expect(latest()).toBeNull();

    await request(child, { type: "compare:set", overlay: A } as never);
    host.set({ checkedOut: B, drafts: [B] });
    await tick();
    expect(latest()).toBeNull();
    done();
  });
});
