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
  // Takes no document: it reads everything from the draft provider above it.
  {
    type: "patchwork:component",
    id: "draft-picker",
    name: "Draft Picker",
    async load() {
      const { renderDraftPicker } = await import("./picker/picker.js");
      return renderDraftPicker;
    },
  },
];

export type {
  CloneEntry,
  DraftDoc,
  DraftList,
  DraftSelection,
  DraftStatus,
  DraftSummary,
} from "./draft-types.js";
export { isDraftDoc } from "./draft-types.js";
