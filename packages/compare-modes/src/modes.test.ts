import { describe, expect, it } from "vitest";
import { OnionSkin, SideBySide, Swipe } from "./modes.js";
import type { Options } from "./types.js";

describe("compare modes", () => {
  it("puts the host back as it was", () => {
    const { host, slots } = setup();
    const dispose = SideBySide.compose!(slots, options(undefined));
    expect(host.style.gridTemplateColumns).toBe("1fr 1fr");
    dispose();
    expect(host.style.gridTemplateColumns).toBe("");
  });

  it("shows B over A by the onion skin's mix, leaving A the pointer", () => {
    const { slots } = setup();
    const mix = options({ mix: 0.25 });
    const dispose = OnionSkin.compose!(slots, mix);
    expect(slots.b.style.opacity).toBe("0.25");
    expect(slots.b.style.pointerEvents).toBe("none");
    mix.set({ mix: 1 });
    expect(slots.b.style.opacity).toBe("1");
    dispose();
    expect(slots.b.style.opacity).toBe("");
    expect(slots.b.style.pointerEvents).toBe("");
  });

  it("clips B at the swipe and takes its divider away after", () => {
    const { host, slots } = setup();
    const dispose = Swipe.compose!(slots, options({ at: 0.25 }));
    expect(slots.b.style.clipPath).toBe("inset(0 0 0 25%)");
    expect(host.querySelector('[role="slider"]')).not.toBeNull();
    dispose();
    expect(host.querySelector('[role="slider"]')).toBeNull();
    expect(slots.b.style.clipPath).toBe("");
  });
});

function setup() {
  const host = document.createElement("div");
  const a = document.createElement("div");
  const b = document.createElement("div");
  host.append(a, b);
  return { host, slots: { a, b } };
}

function options<O>(initial: O): Options<O> {
  let value = initial;
  const listeners = new Set<(value: O) => void>();
  return {
    current: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
