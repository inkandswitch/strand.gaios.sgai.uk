import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  // Mounts inside the draft provider: what the checked-out draft changed.
  {
    type: "patchwork:component",
    id: "patchwork-review-provider",
    name: "Review Provider",
    async load() {
      const { ReviewProvider } = await import("./provider.js");
      return ReviewProvider;
    },
  },
];

export type { ChangeView } from "./provider.js";
