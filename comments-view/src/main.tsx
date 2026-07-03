import { render } from "solid-js/web";
import { RepoContext } from "@automerge/automerge-repo-solid-primitives";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { CommentsView } from "./CommentsView";
import { CommentThreadView } from "./CommentThread";
import type { CommentThread } from "./comments";

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

// Renders a single comment thread from its subdocument handle. Mounted by
// `CommentsView` via `<patchwork-view tool-id="comment-thread">`, one per
// thread, with the thread's subdocument url as `doc-url`.
export const renderCommentThread: ToolImplementation<CommentThread> = (
  handle,
  element
) => {
  return render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <CommentThreadView
          handle={handle}
          element={element}
          repo={element.repo}
        />
      </RepoContext.Provider>
    ),
    element
  );
};
