import { AutomergeUrl } from "@automerge/automerge-repo";

export type TinyPatchworkLayoutDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;

  frameToolId: string;
  /** @deprecated legacy fields, migrated into the threepane config doc */
  accountSidebarToolId?: string;
  contextToolIds?: string[];
  documentToolbarToolIds?: string[];

  tools?: Record<string, AutomergeUrl>;
};

export type ToolRef = [toolId: string, docId: AutomergeUrl];

export type ThreepaneConfigDoc = {
  sidebar: { widgets: ToolRef[] };
  contextbar: { tabs: ToolRef[] };
  doctitle: { tools: ToolRef[] };
};
