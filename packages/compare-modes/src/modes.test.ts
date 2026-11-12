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

  it("fades A with the onion skin's mix", () => {
    const { slots } = setup();
    const mix = options({ mix: 0.25 });
    const dispose = OnionSkin.compose!(slots, mix);
    expect(slots.a.style.opacity).toBe("0.75");
    mix.set({ mix: 1 });
    expect(slots.a.style.opacity).toBe("0");
    dispose();
    expect(slots.a.style.opacity).toBe("");
  });

  it("clips A at the swipe and takes its divider away after", () => {
    const { host, slots } = setup();
    const dispose = Swipe.compose!(slots, options({ at: 0.5 }));
    expect(slots.a.style.clipPath).toBe("inset(0 50% 0 0)");
    expect(host.querySelector('[role="slider"]')).not.toBeNull();
    dispose();
    expect(host.querySelector('[role="slider"]')).toBeNull();
    expect(slots.a.style.clipPath).toBe("");
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
