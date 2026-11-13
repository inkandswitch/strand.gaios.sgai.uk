import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-draft-provider",
    name: "Draft Provider",
    async load() {
      const { DraftProvider } = await import("./providers/DraftProvider.js");
      return DraftProvider;
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
  DraftStatus,
  DraftsState,
} from "./draft-types.js";
export { isDraftDoc } from "./draft-types.js";
