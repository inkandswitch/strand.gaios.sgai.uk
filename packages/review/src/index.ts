import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  // Mounts inside the draft provider: the checked-out draft compared with another.
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

export type { CompareAgainst, CompareChanges, ComparedVersion } from "./provider.js";
export type { CompareMark, Ghost, Mark, MergeMark } from "./compare.js";
