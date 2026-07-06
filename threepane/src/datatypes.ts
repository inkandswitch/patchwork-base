import type { DatatypeImplementation } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc, ThreepaneConfigDoc } from "./types";

/**
 * Default scalar configuration for a fresh account. Subdoc URLs are intentionally
 * absent and are populated lazily by the frame on first mount.
 */
export const AccountDatatype: DatatypeImplementation<AccountDoc> = {
  init(doc) {
    doc.frameToolId = "threepane";
    // The left pane is now a widget list (migrated into the threepane config
    // doc); no default account sidebar tool. The context sidebar is
    // registry-driven now, so there's nothing to seed for it.
    // Title + spacer are rendered intrinsically by the frame's top bar; only the
    // right-hand doctitle tools are configured here.
    doc.documentToolbarToolIds = [
      "add-doc-to-sidebar-button",
      "doc-openwith",
      "doc-presence",
      "sync-indicator",
    ];
  },
  getTitle: () => "Patchwork Account",
};

/** The threepane layout config doc (sidebar widgets, doctitle tools). */
export const ThreepaneConfigDatatype: DatatypeImplementation<ThreepaneConfigDoc> =
  {
    init(doc) {
      doc.sidebar = { widgets: [] };
      doc.doctitle = { tools: [] };
    },
    getTitle: () => "Threepane Config",
  };
