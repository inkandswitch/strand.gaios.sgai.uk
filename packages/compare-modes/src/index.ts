import type { LoadablePlugin } from "@inkandswitch/patchwork-plugins";
import type { CompareModeDescription, CompareModeImplementation } from "./types.js";

export type * from "./types.js";

type Mode = LoadablePlugin<CompareModeDescription, CompareModeImplementation<any>>;

export const plugins: Mode[] = [
  mode("a-only", "A only", new URL("./icons/a-only.svg", import.meta.url), true, "AOnly"),
  mode("b-only", "B only", new URL("./icons/b-only.svg", import.meta.url), true, "BOnly"),
  mode(
    "side-by-side",
    "Side by side",
    new URL("./icons/side-by-side.svg", import.meta.url),
    true,
    "SideBySide"
  ),
  mode("stacked", "Stacked", new URL("./icons/stacked.svg", import.meta.url), true, "Stacked"),
  mode(
    "onion-skin",
    "Onion skin",
    new URL("./icons/onion-skin.svg", import.meta.url),
    false,
    "OnionSkin"
  ),
  mode("swipe", "Swipe", new URL("./icons/swipe.svg", import.meta.url), false, "Swipe"),
  mode("inline", "Combined", new URL("./icons/combined.svg", import.meta.url), false, "Combined"),
];

function mode(
  id: string,
  name: string,
  icon: URL,
  on: boolean,
  exported: keyof typeof import("./modes.js")
): Mode {
  return {
    type: "patchwork:compare-mode",
    id,
    name,
    icon: icon.href,
    default: on,
    async load() {
      return (await import("./modes.js"))[exported];
    },
  };
}
