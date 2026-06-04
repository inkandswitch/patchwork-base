import {
  cursor,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";

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

export function createCommentForRange(
  handle: DocHandle<unknown>,
  path: readonly string[],
  from: number,
  to: number,
  contactUrl: AutomergeUrl
): void {
  const targetUrl = handle.sub(...path, cursor(from, to)).url;
  const threadId = crypto.randomUUID();
  const commentId = crypto.randomUUID();

  handle.change((doc: DocWithComments) => {
    doc["@comments"] ??= { threads: [] };
    doc["@comments"].threads.push({
      id: threadId,
      refs: [targetUrl],
      isResolved: false,
      comments: [
        {
          id: commentId,
          contactUrl,
          timestamp: Date.now(),
        },
      ],
    });
  });
}
