import "./styles.css";
import { useState, useEffect, useMemo } from "react";

import { relativeTime } from "./relative-time";
import { toolify, type ReactToolProps } from "@inkandswitch/patchwork-react";
import { useRepo, useDocument } from "@automerge/automerge-repo-react-hooks";
// (useDocument is still used in CommentView to look up contact docs, just not
// for the aggregate handle — see useDocSnapshot below.)
import {
  findRef,
  type AutomergeUrl,
  type DocHandle,
  type Ref,
  type RefUrl,
  type Repo,
} from "@automerge/automerge-repo";

import { request } from "@inkandswitch/patchwork-providers";
import {
  createReply,
  type Comment,
  type CommentThread,
} from "@inkandswitch/patchwork-comments";
import { useRefValue } from "@inkandswitch/patchwork-refs-react";

type CommentsAggregate = Record<RefUrl, RefUrl[]>;

const VERSION = "v2.0.4";

/**
 * Subscribe to a DocHandle and re-render on every "change" event.
 * Returns the doc snapshot (read fresh from the handle each render).
 *
 * We don't use `useDocument` from @automerge/automerge-repo-react-hooks
 * because it routes through a patch-based store whose `apply_patches`
 * implementation throws when a `del` patch arrives with a string path key
 * (which is exactly what CommentsProvider emits when it clears stale
 * aggregate keys during a rebuild).
 */
function useDocSnapshot<T extends object>(
  handle: DocHandle<T> | null
): T | undefined {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!handle) return;
    console.log("[CommentsView] subscribing to handle", handle.url);
    const bump = () => {
      console.log("[CommentsView] handle change", handle.url);
      setRevision((r) => r + 1);
    };
    handle.on("change", bump);
    // Trigger an initial render after subscription so we re-read once the
    // listener is in place (in case the doc was modified between mount and
    // subscription).
    setRevision((r) => r + 1);
    return () => {
      handle.off("change", bump);
    };
  }, [handle]);
  const doc = handle?.doc();
  console.log(
    "[CommentsView] useDocSnapshot rev=",
    revision,
    "doc=",
    doc
  );
  return doc;
}

const CommentsView = ({ element }: ReactToolProps) => {
  const repo = useRepo();
  const [aggregate, setAggregate] =
    useState<DocHandle<CommentsAggregate> | null>(null);

  useEffect(() => {
    let cancelled = false;
    console.log("[CommentsView] requesting aggregate handle");
    request<CommentsAggregate>(element, "patchwork:comments").then((handle) => {
      if (cancelled) return;
      console.log(
        "[CommentsView] aggregate handle received:",
        handle?.url,
        "initial doc:",
        handle?.doc()
      );
      // Cast across linked-workspace package boundary: `request` lives in
      // patchwork-next/packages/providers and resolves DocHandle types
      // against its own automerge-repo version, not ours.
      setAggregate(handle as unknown as DocHandle<CommentsAggregate> | null);
    });
    return () => {
      cancelled = true;
    };
  }, [element]);

  const aggregateDoc = useDocSnapshot(aggregate);

  const threadUrls = useMemo(() => {
    const urls = aggregateDoc
      ? Array.from(new Set(Object.values(aggregateDoc).flat()))
      : [];
    console.log("[CommentsView] threadUrls:", urls);
    return urls;
  }, [aggregateDoc]);

  return (
    <div className="h-full flex flex-col p-2 gap-2">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span className="font-medium">Comments</span>
        <span>{VERSION}</span>
      </div>
      {threadUrls.map((threadUrl) => (
        <ThreadView key={threadUrl} threadUrl={threadUrl} repo={repo} />
      ))}
    </div>
  );
};

export const renderCommentsView = toolify(CommentsView);

const ThreadView = ({
  threadUrl,
  repo,
}: {
  threadUrl: RefUrl;
  repo: Repo;
}) => {
  const [threadRef, setThreadRef] = useState<Ref<CommentThread> | null>(null);

  useEffect(() => {
    let cancelled = false;
    findRef<CommentThread>(repo, threadUrl)
      .then((ref) => {
        if (cancelled) return;
        setThreadRef(ref);
      })
      .catch((error) => {
        console.error(
          `[comments-view] failed to resolve thread ${threadUrl}`,
          error
        );
      });
    return () => {
      cancelled = true;
    };
  }, [repo, threadUrl]);

  const thread = useRefValue(threadRef ?? undefined);

  // Get current account's contactUrl
  // todo: we should have a better way to get the contactUrl of the current account
  const [currentAccount] = useDocument<{ contactUrl: AutomergeUrl }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).accountDocHandle?.url
  );

  if (!threadRef || !thread) {
    return null;
  }

  const { comments } = thread;

  const onResolveThread = () => {
    threadRef.change((t) => {
      t.isResolved = true;
    });
  };

  const onReplyToComment = () => {
    if (!currentAccount?.contactUrl) return;
    createReply({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      threadRef: threadRef as any,
      content: "",
      contactUrl: currentAccount.contactUrl,
    });
  };

  const onDeleteComment = (commentRef: Ref) => {
    commentRef.remove();
    if (threadRef.value()?.comments.length === 0) {
      threadRef.remove();
    }
  };

  // Find draft comment if any
  const draftComment = comments.find(
    (c) => c.draftContent !== undefined || c.content === undefined
  );
  const draftCommentRef = draftComment
    ? threadRef.docHandle.ref(
        "@comments",
        "threads",
        { id: thread.id },
        "comments",
        { id: draftComment.id }
      )
    : null;

  const onSaveDraft = () => {
    if (!draftCommentRef) return;
    draftCommentRef.change((comment: Comment) => {
      comment.content = comment.draftContent;
      comment.timestamp = Date.now();
      delete comment.draftContent;
    });
  };

  const onCancelDraft = () => {
    if (!draftCommentRef) return;
    const commentValue = draftCommentRef.value() as Comment | undefined;
    if (commentValue?.content === undefined) {
      onDeleteComment(draftCommentRef);
      return;
    }
    draftCommentRef.change((comment: Comment) => {
      delete comment.draftContent;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="card card-bordered shadow-sm bg-white border border-gray-200">
        <div className="card-body p-2 space-y-2">
          {comments.map((comment) => {
            const commentRef = threadRef.docHandle.ref(
              "@comments",
              "threads",
              { id: thread.id },
              "comments",
              { id: comment.id }
            );

            return (
              <CommentView
                key={commentRef.url}
                commentRef={commentRef}
                currentContactUrl={currentAccount?.contactUrl}
              />
            );
          })}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        {draftComment ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={onCancelDraft}>
              Cancel
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onSaveDraft}>
              Save
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onResolveThread}
              title="Resolve comment"
            >
              Resolve
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onReplyToComment}
              title="Reply to comment"
            >
              Reply
            </button>
          </>
        )}
      </div>
    </div>
  );
};

type CommentViewProps = {
  commentRef: Ref;
  currentContactUrl?: string;
};

type ContactDoc = { type: "anonymous" } | { type: "registered"; name: string };

const CommentView = ({ commentRef, currentContactUrl }: CommentViewProps) => {
  const comment = useRefValue(commentRef) as Comment | undefined;
  const [contact] = useDocument<ContactDoc>(
    comment?.contactUrl as AutomergeUrl
  );

  if (!comment) {
    return null;
  }

  const { content, timestamp, draftContent } = comment;
  const isDraft = draftContent !== undefined || content === undefined;

  // Hide drafts from other users
  if (isDraft && comment.contactUrl !== currentContactUrl) {
    return null;
  }

  const contactName =
    contact?.type === "registered" ? contact.name : "Anonymous";

  const onChangeDraft = (newDraftContent: string) => {
    commentRef.change((c: Comment) => {
      c.draftContent = newDraftContent;
    });
  };

  return (
    <div className="space-y-2" data-id={commentRef.url}>
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <patchwork-view
            doc-url={comment.contactUrl}
            tool-id="contact-avatar"
          />
          <span className="text-sm font-medium whitespace-nowrap">
            {contactName}
          </span>
        </div>
        {!isDraft && timestamp && (
          <span className="text-xs text-gray-400">
            {relativeTime(timestamp)}
          </span>
        )}
      </div>
      {isDraft ? (
        <textarea
          className="textarea w-full min-h-24 border border-gray-300 rounded-lg p-2"
          value={draftContent ?? ""}
          onChange={(e) => onChangeDraft(e.target.value)}
        />
      ) : (
        <div className="text-base text-gray-800 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
};

