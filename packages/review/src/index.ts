import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  // Reads the draft from the draft provider above it.
  {
    type: "patchwork:tool",
    id: "review",
    name: "Review",
    icon: "GitCompare",
    supportedDatatypes: ["folder", "directory"],
    unlisted: true,
    async load() {
      const { renderReview } = await import("./review.js");
      return renderReview;
    },
  },
];
