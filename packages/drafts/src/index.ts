import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-overlay-provider",
    name: "Overlay Provider",
    async load() {
      const { OverlayProvider } = await import("./providers/OverlayProvider.js");
      return OverlayProvider;
    },
  },
  {
    type: "patchwork:datatype",
    id: "patchwork:draft",
    name: "Draft",
    async load() {
      const { DraftDatatype } = await import("./DraftDatatype.js");
      return DraftDatatype;
    },
    unlisted: true,
  },
];

export type {
  CloneEntry,
  DraftDoc,
  DraftEntry,
  Member,
  MergeDoc,
  MergeEntry,
  Overlay,
  OverlaysState,
  OverlayStatus,
} from "./overlay-types.js";
export { isDraftDoc, isMergeDoc } from "./overlay-types.js";
