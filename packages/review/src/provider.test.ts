import { describe, expect, it } from "vitest";
import { accept, request, subscribe, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import { CompareProvider, type Comparison } from "./provider.js";

const A = "automerge:2y3c9FQ2RBQTqgrEW4yW7uEDdtQ6" as const;
const B = "automerge:3U4FuN9HU7s4mxg9qRkbFsvpW19m" as const;
const M = "automerge:4NMNnkaBhtDxSNQvmFNh1BMAUBhC" as const;

// An overlay provider that answers `overlays` with whatever it's given.
type Shape = {
  checkedOut: string | null;
  at?: string | null;
  drafts: string[];
  merges?: { url: string; source: string | null; target: string | null }[];
};

function overlays(initial: Shape) {
  const parent = document.createElement("div");
  let state = initial;
  const listeners = new Set<(value: unknown) => void>();
  const shape = () => ({
    checkedOut: state.checkedOut,
    at: state.at ?? null,
    status: "ready",
    drafts: state.drafts.map((url) => ({ url, name: "Draft", parent: null })),
    merges: (state.merges ?? []).map((merge) => ({ ...merge, published: false })),
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
  const set = (next: Shape) => {
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
    expect(latest()).toEqual({ kind: "compare", a: A, b: null, aAt: null, bAt: null });
    done();
  });

  it("compares with what's set until it's cleared", async () => {
    const { child, latest, tick, done } = mount();
    await tick();
    expect(latest()).toBeNull();
    expect(await request(child, { type: "compare:set", overlay: B } as never)).toBe(true);
    expect(latest()).toEqual({ kind: "compare", a: A, b: B, aAt: null, bAt: null });
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

  it("shows a checked-out merge against its target, as a merge, whatever was set", async () => {
    const { child, host, latest, tick, done } = mount();
    await tick();
    await request(child, { type: "compare:set", overlay: B } as never);
    host.set({ checkedOut: M, drafts: [A, B], merges: [{ url: M, source: A, target: null }] });
    await tick();
    expect(latest()).toEqual({
      kind: "merge",
      a: M,
      b: null,
      source: A,
      target: null,
      published: false,
    });
    expect(await request(child, { type: "compare:set", overlay: A } as never)).toBeNull();
    expect(await request(child, { type: "compare:clear" } as never)).toBeNull();

    // What was set comes back once the merge isn't checked out.
    host.set({ checkedOut: A, drafts: [A, B] });
    await tick();
    expect(latest()).toEqual({ kind: "compare", a: A, b: B, aAt: null, bAt: null });
    done();
  });

  it("compares two points in one overlay's history", async () => {
    const { child, host, latest, tick, done } = mount();
    await tick();
    host.set({ checkedOut: B, at: "later", drafts: [A, B] });
    expect(await request(child, { type: "compare:set", overlay: B, at: "earlier" } as never)).toBe(true);
    expect(latest()).toEqual({ kind: "compare", a: B, b: B, aAt: "later", bAt: "earlier" });

    // The same point as what's checked out is nothing to compare.
    host.set({ checkedOut: B, at: "earlier", drafts: [A, B] });
    await tick();
    expect(latest()).toBeNull();
    done();
  });
});
