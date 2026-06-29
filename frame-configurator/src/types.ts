import { AutomergeUrl } from "@automerge/automerge-repo";

export type TinyPatchworkLayoutDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;

  frameToolId: string;
<<<<<<< Updated upstream
=======
<<<<<<< Updated upstream
  accountSidebarToolId: string;
  contextToolIds: string[];
  documentToolbarToolIds: string[];
=======
>>>>>>> Stashed changes
  /** @deprecated legacy fields, migrated into the threepane config doc */
  accountSidebarToolId?: string;
  contextToolIds?: string[];
  documentToolbarToolIds?: string[];

  tools?: Record<string, AutomergeUrl>;
};

export type ToolRef = [toolId: string, docId: AutomergeUrl];

<<<<<<< Updated upstream
export type ThreepaneConfigDoc = {
  sidebar: { widgets: ToolRef[] };
  contextbar: { tabs: ToolRef[] };
  doctitle: { tools: ToolRef[] };
=======
/** A doctitle/tray entry: a `[toolId, docId]` tool tuple or a bare component id. */
export type ToolSlot = ToolRef | string;

export type ThreepaneConfigDoc = {
  sidebar: { widgets: ToolRef[] };
  contextbar: { tabs: ToolRef[] };
  doctitle: { tools: ToolSlot[] };
  tray: { tools: ToolSlot[] };
>>>>>>> Stashed changes
>>>>>>> Stashed changes
};
