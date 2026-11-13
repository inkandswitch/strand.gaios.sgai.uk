import type { CompareModeImplementation, Options, Slots } from "./types.js";

export const AOnly: CompareModeImplementation = {
  compose: ({ b }) => hide(b),
};

export const BOnly: CompareModeImplementation = {
  compose: ({ a }) => hide(a),
};

export const SideBySide: CompareModeImplementation = {
  compose: ({ a }) => style(a.parentElement!, { gridTemplateColumns: "1fr 1fr" }),
};

export const Stacked: CompareModeImplementation = {
  compose: ({ a }) => style(a.parentElement!, { gridTemplateRows: "1fr 1fr" }),
};

/** How much of B shows over A: 0 is all A, 1 all B. */
type Mix = { mix: number };

// B lies over A and shows as the mix moves towards it. A stays the one that
// takes the pointer.
export const OnionSkin: CompareModeImplementation<Mix> = {
  options: { mix: 0.5 },
  compose(slots, options) {
    const restore = overlay(slots);
    const apply = ({ mix }: Mix) => (slots.b.style.opacity = String(mix));
    apply(options.current());
    const stop = options.subscribe(apply);
    return () => {
      stop();
      restore();
    };
  },
  controls(element, options) {
    return slider(element, "Mix", options.current().mix, (mix) => options.set({ mix }), (set) =>
      options.subscribe(({ mix }) => set(mix))
    );
  },
};

/** Where the divider is, across the width: A shows to its left. */
type At = { at: number };

export const Swipe: CompareModeImplementation<At> = {
  options: { at: 0.5 },
  compose(slots, options) {
    const host = slots.a.parentElement!;
    const restore = overlay(slots);
    const divider = document.createElement("div");
    divider.setAttribute("role", "slider");
    divider.setAttribute("aria-label", "Swipe between A and B");
    divider.setAttribute("aria-valuemin", "0");
    divider.setAttribute("aria-valuemax", "100");
    divider.tabIndex = 0;
    Object.assign(divider.style, {
      position: "absolute",
      insetBlock: "0",
      inlineSize: "16px",
      marginInlineStart: "-8px",
      cursor: "ew-resize",
      zIndex: "2",
      touchAction: "none",
      background:
        "linear-gradient(to right, transparent 7px, var(--projects-ink, currentColor) 7px, var(--projects-ink, currentColor) 9px, transparent 9px)",
    });
    host.append(divider);

    const apply = ({ at }: At) => {
      slots.b.style.clipPath = `inset(0 0 0 ${at * 100}%)`;
      divider.style.insetInlineStart = `${at * 100}%`;
      divider.setAttribute("aria-valuenow", String(Math.round(at * 100)));
    };
    apply(options.current());
    const stop = options.subscribe(apply);

    const moveTo = (x: number) => {
      const box = host.getBoundingClientRect();
      options.set({ at: clamp((x - box.left) / box.width) });
    };
    divider.addEventListener("pointerdown", (event) => {
      divider.setPointerCapture(event.pointerId);
      moveTo(event.clientX);
    });
    divider.addEventListener("pointermove", (event) => {
      if (divider.hasPointerCapture(event.pointerId)) moveTo(event.clientX);
    });
    divider.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
      if (!step) return;
      event.preventDefault();
      options.set({ at: clamp(options.current().at + step) });
    });

    return () => {
      stop();
      divider.remove();
      restore();
    };
  },
};

// Both drawn by the view: the other version's changes marked in this one,
// and those alone, with what's the same on both folded away.
export const Inline: CompareModeImplementation = {};

export const ChangesOnly: CompareModeImplementation = {};

function hide(element: HTMLElement) {
  element.hidden = true;
  return () => {
    element.hidden = false;
  };
}

// Sets styles, and puts back what was there.
function style(element: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  const before = Object.fromEntries(
    Object.keys(styles).map((key) => [key, element.style[key as never]])
  );
  Object.assign(element.style, styles);
  return () => Object.assign(element.style, before);
}

// Both views in the one cell, B on top, letting the pointer through to A.
function overlay({ a, b }: Slots) {
  const restore = [
    style(a, { gridArea: "1 / 1" }),
    style(b, { gridArea: "1 / 1", zIndex: "1", pointerEvents: "none" }),
  ];
  return () => {
    for (const undo of restore) undo();
    b.style.opacity = "";
    b.style.clipPath = "";
  };
}

function slider(
  element: HTMLElement,
  label: string,
  value: number,
  set: (value: number) => void,
  follow: (update: (value: number) => void) => () => void
) {
  const wrapper = document.createElement("label");
  wrapper.className = "compare-modes__control";
  const input = Object.assign(document.createElement("input"), {
    type: "range",
    min: "0",
    max: "1",
    step: "0.01",
    value: String(value),
  });
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => set(input.valueAsNumber));
  const stop = follow((next) => (input.value = String(next)));
  wrapper.append("A ", input, " B");
  element.append(wrapper);
  return () => {
    stop();
    wrapper.remove();
  };
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}
