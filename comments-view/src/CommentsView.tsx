import "./styles.css";
import {
  createSignal,
  createMemo,
  createEffect,
  onCleanup,
  Show,
  For,
} from "solid-js";

import { relativeTime } from "./relative-time";
import {
  useDocument,
  useRepo,
} from "@automerge/automerge-repo-solid-primitives";
import {
  findRef,
  type AutomergeUrl,
  type Ref,
  type RefUrl,
  type Repo,
} from "@automerge/automerge-repo";

import { request } from "@inkandswitch/patchwork-providers-solid";
import {
  createReply,
  type Comment,
  type CommentThread,
} from "@inkandswitch/patchwork-comments";

const VERSION = "v2.1.8";

export function CommentsView(props: { element: HTMLElement }) {
  const repo = useRepo();

  const [allComments] = request<{
    comments: { targetRef: RefUrl; threadRef: RefUrl }[];
  }>(props.element, "patchwork:comments");

  const threadUrls = createMemo<RefUrl[]>(() => {
    const entries = allComments()?.comments;
    if (!entries) return [];
    const seen = new Set<RefUrl>();
    const urls: RefUrl[] = [];
    for (const { threadRef } of entries) {
      if (seen.has(threadRef)) continue;
      seen.add(threadRef);
      urls.push(threadRef);
    }
    return urls;
  });

  return (
    <div class="h-full flex flex-col p-2 gap-2">
      <div class="flex items-center justify-between text-xs text-gray-400">
        <span class="font-medium">Comments</span>
        <span>{VERSION}</span>
      </div>
      <For each={threadUrls()}>
        {(threadUrl) => <ThreadView threadUrl={threadUrl} repo={repo} />}
      </For>
    </div>
  );
}

function ThreadView(props: { threadUrl: RefUrl; repo: Repo }) {
  // TODO: drop this async findRef dance once subdoc handles land — we'll
  // be able to resolve a RefUrl synchronously from the parent handle.
  const [threadRef, setThreadRef] = createSignal<
    Ref<CommentThread> | undefined
  >(undefined);

  createEffect(() => {
    let cancelled = false;
    setThreadRef(() => undefined);
    findRef<CommentThread>(props.repo, props.threadUrl)
      .then((ref) => {
        if (cancelled) return;
        setThreadRef(() => ref);
      })
      .catch((error) => {
        console.error(
          `[comments-view] failed to resolve thread ${props.threadUrl}`,
          error
        );
      });
    onCleanup(() => {
      cancelled = true;
    });
  });

  // TODO: replace this manual ref→signal wiring once subdoc handles land —
  // a subdoc handle is itself reactive and can be projected directly.
  const [thread, setThread] = createSignal<CommentThread | undefined>(
    undefined
  );
  createEffect(() => {
    const r = threadRef();
    if (!r) {
      setThread(() => undefined);
      return;
    }
    setThread(() => r.value());
    onCleanup(r.onChange(() => setThread(() => r.value())));
  });

  // Stable list of comment ids. `thread().comments` is a fresh Automerge proxy
  // on every change, so iterating over it with <For> would tear down every
  // comment row (and its focused draft textarea) on each keystroke. Returning
  // the previous array when the id sequence is unchanged keeps <For> stable.
  const commentIds = createMemo<string[]>((prev) => {
    const t = thread();
    if (!t) return [];
    const next: string[] = [];
    for (const c of t.comments) next.push(c.id);
    if (
      prev &&
      prev.length === next.length &&
      next.every((id, i) => id === prev[i])
    ) {
      return prev;
    }
    return next;
  }, []);

  // todo: we should have a better way to get the contactUrl of the current account
  const accountUrl = () =>
    (window as any).accountDocHandle?.url as AutomergeUrl | undefined;
  const [currentAccount] = useDocument<{ contactUrl: AutomergeUrl }>(
    accountUrl,
    { repo: props.repo }
  );

  const draftComment = createMemo(() => {
    const t = thread();
    if (!t) return undefined;
    return t.comments.find(
      (c) => c.draftContent !== undefined || c.content === undefined
    );
  });

  const draftCommentRef = createMemo(() => {
    const r = threadRef();
    const t = thread();
    const d = draftComment();
    if (!r || !t || !d) return undefined;
    return r.docHandle.ref(
      "@comments",
      "threads",
      { id: t.id },
      "comments",
      { id: d.id }
    );
  });

  const onResolveThread = () => {
    const r = threadRef();
    if (!r) return;
    r.change((t) => {
      t.isResolved = true;
    });
  };

  const onReplyToComment = () => {
    const r = threadRef();
    const account = currentAccount();
    if (!r || !account?.contactUrl) return;
    createReply({
      threadRef: r as any,
      content: "",
      contactUrl: account.contactUrl,
    });
  };

  const onDeleteComment = (commentRef: Ref) => {
    const r = threadRef();
    commentRef.remove();
    if (r?.value()?.comments.length === 0) {
      r.remove();
    }
  };

  const onSaveDraft = () => {
    const r = draftCommentRef();
    if (!r) return;
    r.change((comment: Comment) => {
      comment.content = comment.draftContent;
      comment.timestamp = Date.now();
      delete comment.draftContent;
    });
  };

  const onCancelDraft = () => {
    const r = draftCommentRef();
    if (!r) return;
    const commentValue = r.value() as Comment | undefined;
    if (commentValue?.content === undefined) {
      onDeleteComment(r);
      return;
    }
    r.change((comment: Comment) => {
      delete comment.draftContent;
    });
  };

  return (
    <Show when={thread() && threadRef()}>
      <div class="flex flex-col gap-2">
        <div class="card card-bordered shadow-sm bg-white border border-gray-200">
          <div class="card-body p-2 space-y-2">
            <For each={commentIds()}>
              {(commentId) => {
                const commentRef = createMemo(() => {
                  const r = threadRef();
                  const t = thread();
                  if (!r || !t) return undefined;
                  return r.docHandle.ref(
                    "@comments",
                    "threads",
                    { id: t.id },
                    "comments",
                    { id: commentId }
                  );
                });
                return (
                  <Show when={commentRef()}>
                    {(ref) => (
                      <CommentView
                        commentRef={ref()}
                        currentContactUrl={currentAccount()?.contactUrl}
                        repo={props.repo}
                      />
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </div>
        <div class="flex gap-2 justify-end">
          <Show
            when={draftComment()}
            fallback={
              <>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick={onResolveThread}
                  title="Resolve comment"
                >
                  Resolve
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick={onReplyToComment}
                  title="Reply to comment"
                >
                  Reply
                </button>
              </>
            }
          >
            <button class="btn btn-ghost btn-sm" onClick={onCancelDraft}>
              Cancel
            </button>
            <button class="btn btn-ghost btn-sm" onClick={onSaveDraft}>
              Save
            </button>
          </Show>
        </div>
      </div>
    </Show>
  );
}

type ContactDoc = { type: "anonymous" } | { type: "registered"; name: string };

function CommentView(props: {
  commentRef: Ref;
  currentContactUrl?: string;
  repo: Repo;
}) {
  // TODO: replace this manual ref→signal wiring once subdoc handles land —
  // a subdoc handle is itself reactive and can be projected directly.
  const [comment, setComment] = createSignal<Comment | undefined>(undefined);
  createEffect(() => {
    const r = props.commentRef;
    setComment(() => r.value() as Comment | undefined);
    onCleanup(
      r.onChange(() => setComment(() => r.value() as Comment | undefined))
    );
  });

  const contactUrl = () => comment()?.contactUrl as AutomergeUrl | undefined;
  const [contact] = useDocument<ContactDoc>(contactUrl, { repo: props.repo });

  const isDraft = () => {
    const c = comment();
    if (!c) return false;
    return c.draftContent !== undefined || c.content === undefined;
  };

  // Hide drafts from other users.
  const shouldRender = () => {
    const c = comment();
    if (!c) return false;
    if (isDraft() && c.contactUrl !== props.currentContactUrl) return false;
    return true;
  };

  const contactName = () => {
    const ct = contact();
    return ct?.type === "registered" ? ct.name : "Anonymous";
  };

  const onChangeDraft = (newDraftContent: string) => {
    props.commentRef.change((c: Comment) => {
      c.draftContent = newDraftContent;
    });
  };

  return (
    <Show when={shouldRender() && comment()}>
      <div class="space-y-2" data-id={props.commentRef.url}>
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-2">
            <patchwork-view
              doc-url={comment()!.contactUrl}
              tool-id="contact-avatar"
            />
            <span class="text-sm font-medium whitespace-nowrap">
              {contactName()}
            </span>
          </div>
          <Show when={!isDraft() && comment()!.timestamp}>
            <span class="text-xs text-gray-400">
              {relativeTime(comment()!.timestamp!)}
            </span>
          </Show>
        </div>
        <Show
          when={isDraft()}
          fallback={
            <div class="text-base text-gray-800 whitespace-pre-wrap">
              {comment()!.content}
            </div>
          }
        >
          <textarea
            class="textarea w-full min-h-24 border border-gray-300 rounded-lg p-2"
            value={comment()!.draftContent ?? ""}
            onInput={(e) => onChangeDraft(e.currentTarget.value)}
          />
        </Show>
      </div>
    </Show>
  );
}
