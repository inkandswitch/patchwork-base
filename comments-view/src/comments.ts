import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";

export type DocWithComments = {
  "@comments"?: {
    threads: CommentThread[];
  };
};

export type CommentThread = {
  id: string;
  refs: AutomergeUrl[];
  isResolved: boolean;
  comments: Comment[];
};

export type Comment = {
  id: string;
  content?: string;
  draftContent?: string;
  contactUrl: AutomergeUrl;
  timestamp: number;
};

export function createReply({
  threadHandle: thread,
  content,
  contactUrl,
}: {
  threadHandle: DocHandle<CommentThread>;
  content?: string;
  contactUrl: AutomergeUrl;
}): DocHandle<Comment> {
  const commentId = crypto.randomUUID();

  thread.change((thread) => {
    const comment: Comment = {
      id: commentId,
      contactUrl,
      timestamp: Date.now(),
    };

    if (content) comment.content = content;
    thread.comments.push(comment);
  });

  return thread.sub("comments", { id: commentId }) as DocHandle<Comment>;
}
