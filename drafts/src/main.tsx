import { render } from "solid-js/web";
import { RepoContext } from "@automerge/automerge-repo-solid-primitives";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { DraftsSidebar } from "./DraftsSidebar";

export const renderDraftsSidebar: ToolImplementation = (_handle, element) => {
  return render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <DraftsSidebar element={element} />
      </RepoContext.Provider>
    ),
    element
  );
};
