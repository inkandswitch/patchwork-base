import { AutomergeUrl } from "@automerge/automerge-repo";

/**
 * The account document for a Patchwork frame.
 *
 * Scalar configuration (frame/sidebar/toolbar tool ids) is populated eagerly
 * by AccountDatatype.init. Subdocument URLs (rootFolderUrl, moduleSettingsUrl,
 * contactUrl) are optional and are lazily populated by the frame on first
 * mount via createDocOfDatatype2 of their respective datatypes.
 */
export type AccountDoc = {
  frameToolId: string;
  /** @deprecated no longer defaulted; the left pane is now sidebar.widgets */
  accountSidebarToolId?: string;
  /** @deprecated seeds migration into the threepane config doc's contextbar.tabs */
  contextToolIds?: string[];
  /** @deprecated seeds migration into the threepane config doc's doctitle.tools */
  documentToolbarToolIds?: string[];

  rootFolderUrl?: AutomergeUrl;
  moduleSettingsUrl?: AutomergeUrl;
  contactUrl?: AutomergeUrl;

  /**
   * Per-tool config doc urls, keyed by tool id. `tools["threepane"]` points at
   * a ThreepaneConfigDoc holding the sidebar/contextbar/doctitle layout.
   */
  tools?: Record<string, AutomergeUrl>;
};

/** @deprecated use AccountDoc */
export type TinyPatchworkConfigDoc = AccountDoc;

/**
 * A configured tool slot: which tool, and which document it renders against.
 * The docid is a real pin — every lane renders the tuple's tool against the
 * document the tuple itself names.
 */
export type ToolRef = [toolId: string, docId: AutomergeUrl];

/**
 * One entry in a tool lane (sidebar / doctitle / tray / contextbar). Either a
 * `[toolId, docId]` tuple rendered as a `patchwork:tool` against the doc the
 * tuple names, or a bare component id rendered as a `patchwork:component` (with
 * no document).
 */
export type ToolSlot = ToolRef | string;

/**
 * The threepane layout config (its own document, referenced from
 * `AccountDoc.tools["threepane"]`).
 */
export type ThreepaneConfigDoc = {
  sidebar: { widgets: ToolSlot[] };
  contextbar: { tabs: ToolSlot[] };
  doctitle: { tools: ToolSlot[] };
  tray: { tools: ToolSlot[] };
};
