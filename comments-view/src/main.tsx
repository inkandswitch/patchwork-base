import { render } from "solid-js/web";
import { RepoContext } from "@automerge/automerge-repo-solid-primitives";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { CommentsView } from "./CommentsView";

export const renderCommentsView: ToolImplementation = (_handle, element) => {
  return render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <CommentsView element={element} />
      </RepoContext.Provider>
    ),
    element
  );
};
