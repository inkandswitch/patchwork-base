import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";

import type { DraftDoc } from "./draft-types.js";

export const DraftDatatype: DatatypeImplementation<DraftDoc> = {
  init(doc: DraftDoc) {
    doc["@patchwork"] = { type: "draft" };
    doc.parentDraftUrl = null;
    doc.drafts = [];
    doc.clones = {};
  },
  getTitle() {
    return "Draft";
  },
};
