import type { HistoryGroupingsDoc } from "./types";

export const HistoryGroupingsDatatype = {
  init: (doc: HistoryGroupingsDoc) => {
    if (!doc.sourceDocumentUrl) return;
    Object.assign(doc, {
      ["@patchwork"]: { type: "patchwork:history-change-groups" },
      version: doc.version || 1,
      sourceDocumentUrl: doc.sourceDocumentUrl,
      updatedAt: doc.updatedAt || 0,
      throttleMs: doc.throttleMs || 30 * 60 * 1000,
      heads: doc.heads || [],
      groupings: doc.groupings || {},
    } as HistoryGroupingsDoc);
  },
  getTitle: (doc: HistoryGroupingsDoc) => {
    return `History Change Groups for ${doc.sourceDocumentUrl}`;
  },
};
