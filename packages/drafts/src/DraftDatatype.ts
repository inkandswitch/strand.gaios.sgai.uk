import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";

import type { DraftDoc } from "./overlay-types.js";

export const DraftDatatype: DatatypeImplementation<DraftDoc> = {
  init(doc: DraftDoc) {
    doc["@patchwork"] = { type: "draft" };
    doc.parent = null;
    doc.clones = {};
  },
  getTitle(doc) {
    return doc.name ?? "Draft";
  },
};
