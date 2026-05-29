import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import type { LegacyPatchworkViewElement } from "@inkandswitch/patchwork-elements";

export interface PatchworkToolProps<T> {
  handle: DocHandle<T>;
  repo: Repo;
  element: LegacyPatchworkViewElement;
}

export type TinyPatchworkAccountDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;
};
