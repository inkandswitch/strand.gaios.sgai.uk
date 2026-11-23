import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  // Mounts inside the overlay provider: the checked-out overlay compared with another.
  {
    type: "patchwork:component",
    id: "patchwork-compare-provider",
    name: "Compare Provider",
    async load() {
      const { CompareProvider } = await import("./provider.js");
      return CompareProvider;
    },
  },
];

export type { Comparison, Overlay } from "./provider.js";
