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

/**
 * Create a document-level comment thread: one that targets the whole
 * document (its only ref is the document's own url) rather than a range or
 * sub-doc within it. Used when the active tool or datatype can't locate
 * comments to a specific spot. Returns a handle to the seeded draft comment.
 */
export function createDocumentThread({
  docHandle,
  contactUrl,
  content,
}: {
  docHandle: DocHandle<DocWithComments>;
  contactUrl: AutomergeUrl;
  content?: string;
}): DocHandle<Comment> {
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();

  docHandle.change((doc) => {
    doc["@comments"] ??= { threads: [] };
    const comment: Comment = {
      id: commentId,
      contactUrl,
      timestamp: Date.now(),
    };
    if (content) comment.content = content;
    doc["@comments"].threads.push({
      id: threadId,
      refs: [docHandle.url],
      isResolved: false,
      comments: [comment],
    });
  });

  return docHandle.sub("@comments", "threads", {
    id: threadId,
  }).sub("comments", { id: commentId }) as DocHandle<Comment>;
}

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
