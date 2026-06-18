import { AutomergeUrl } from "@automerge/automerge-repo";

export type TinyPatchworkLayoutDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;

  frameToolId: string;
  accountSidebarToolId: string;
  contextToolIds: string[];
  documentToolbarToolIds: string[];
};
