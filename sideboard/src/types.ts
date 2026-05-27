import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import type { PatchworkViewLegacyElement } from "@inkandswitch/patchwork-elements";

export interface PatchworkToolProps<T> {
  handle: DocHandle<T>;
  repo: Repo;
  element: PatchworkViewLegacyElement;
}

export type TinyPatchworkAccountDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;
};
