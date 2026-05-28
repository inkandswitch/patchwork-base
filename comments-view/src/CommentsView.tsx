import "./styles.css";
// Pulls in <patchwork-view> JSX intrinsic type augmentations.
import type {} from "@inkandswitch/patchwork-elements";
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

import { requestDoc } from "@inkandswitch/patchwork-providers-solid";
import {
  useResolvedRefs,
  useResolvedRefMap,
} from "@inkandswitch/patchwork-solid";
import {
  createReply,
  type Comment,
  type CommentThread,
} from "@inkandswitch/patchwork-comments";

const VERSION = "v2.3.9-comments";

export function CommentsView(props: { element: HTMLElement }) {
  const repo = useRepo();

  const [allComments] = requestDoc<{
    comments: { targetRef: RefUrl; threadRef: RefUrl }[];
  }>(props.element, "patchwork:comments");

  // `selection` is read-only input (driven by the active editor), `highlight`
  // is our output. Splitting them avoids the feedback loop a single shared
  // map would have.
  const [focusDoc, focusHandle] = requestDoc<{
    selection: Record<RefUrl, true>;
    highlight: Record<RefUrl, true>;
  }>(props.element, "patchwork:focus");

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

  const threadTargetUrlMap = createMemo<Map<RefUrl, RefUrl[]>>(() => {
    const entries = allComments()?.comments;
    const map = new Map<RefUrl, RefUrl[]>();
    if (!entries) return map;
    for (const { targetRef, threadRef } of entries) {
      const existing = map.get(threadRef);
      if (existing) {
        if (!existing.includes(targetRef)) existing.push(targetRef);
      } else {
        map.set(threadRef, [targetRef]);
      }
    }
    return map;
  });

  const selectedRefs = useResolvedRefs(
    () => Object.keys(focusDoc()?.selection ?? {}) as RefUrl[],
    repo
  );

  const threadTargetRefMap = useResolvedRefMap(threadTargetUrlMap, repo);

  const overlappingThreads = createMemo<RefUrl[]>(() =>
    threadUrls().filter((url) =>
      threadOverlapsSelection(
        threadTargetRefMap().get(url) ?? [],
        selectedRefs()
      )
    )
  );

  // Tiebreaker for when several threads share the same range — without it
  // the second of two threads on the same target would be unselectable.
  const [pinnedThread, setPinnedThread] = createSignal<RefUrl | undefined>();

  const primaryThreadUrl = createMemo<RefUrl | undefined>(() => {
    const overlaps = overlappingThreads();
    if (overlaps.length === 0) return undefined;
    const pinned = pinnedThread();
    if (pinned && overlaps.includes(pinned)) return pinned;
    return overlaps[0];
  });

  const secondaryThreadUrls = createMemo(() => {
    const p = primaryThreadUrl();
    return new Set(overlappingThreads().filter((u) => u !== p));
  });

  createEffect(() => {
    const handle = focusHandle();
    if (!handle) return;
    const p = primaryThreadUrl();
    const urls = p ? (threadTargetUrlMap().get(p) ?? []) : [];
    const desired: Record<RefUrl, true> = {};
    for (const u of urls) desired[u] = true;
    handle.change((doc) => {
      doc.highlight = desired;
    });
  });

  // Clicking a thread card pins it and jumps `selection` to its targets;
  // the editor's next cursor move will overwrite `selection` again.
  const onSelectThread = (threadUrl: RefUrl, targetUrls: RefUrl[]) => {
    const handle = focusHandle();
    if (!handle) return;
    const wasPrimary = primaryThreadUrl() === threadUrl;
    setPinnedThread(wasPrimary ? undefined : threadUrl);
    const next: Record<RefUrl, true> = {};
    if (!wasPrimary) for (const u of targetUrls) next[u] = true;
    handle.change((doc) => {
      doc.selection = next;
    });
  };

  onCleanup(() => {
    const handle = focusHandle();
    if (!handle) return;
    handle.change((doc) => {
      doc.highlight = {} as Record<RefUrl, true>;
    });
  });

  return (
    <div class="h-full flex flex-col p-2 gap-2">
      <div class="flex items-center justify-between text-xs text-gray-400">
        <span class="font-medium">Comments</span>
        <span>{VERSION}</span>
      </div>
      <For each={threadUrls()}>
        {(threadUrl) => (
          <ThreadView
            threadUrl={threadUrl}
            repo={repo}
            primaryThreadUrl={primaryThreadUrl}
            secondaryThreadUrls={secondaryThreadUrls}
            onSelectThread={onSelectThread}
          />
        )}
      </For>
    </div>
  );
}

function threadOverlapsSelection(targets: Ref[], selection: Ref[]): boolean {
  return targets.some((t) => selection.some((s) => refsOverlap(s, t)));
}

// True when two refs target overlapping content in the same doc. Tries the
// built-in ref checks first (equality, parent/child containment, range
// overlap), then falls back to a point-in-range check so a bare cursor still
// matches an enclosing cursor range — `Ref.overlaps()` uses strict `<` and
// rejects zero-width ranges.
function refsOverlap(a: Ref, b: Ref): boolean {
  if (a.docHandle.url !== b.docHandle.url) return false;
  try {
    if (a.equals(b) || a.contains(b) || b.contains(a) || a.overlaps(b)) {
      return true;
    }
    const aPos = a.rangePositions;
    const bPos = b.rangePositions;
    if (!aPos || !bPos) return false;
    const aIsCursor = aPos[0] === aPos[1];
    const bIsCursor = bPos[0] === bPos[1];
    if (!aIsCursor && !bIsCursor) return false;
    const point = aIsCursor ? aPos[0] : bPos[0];
    const [rangeStart, rangeEnd] = aIsCursor ? bPos : aPos;
    return rangeStart <= point && point <= rangeEnd;
  } catch {
    return false;
  }
}

function ThreadView(props: {
  threadUrl: RefUrl;
  repo: Repo;
  primaryThreadUrl: () => RefUrl | undefined;
  secondaryThreadUrls: () => Set<RefUrl>;
  onSelectThread: (threadUrl: RefUrl, targetUrls: RefUrl[]) => void;
}) {
  // TODO: drop this async findRef + manual ref→signal dance once subdoc
  // handles land — they'll be synchronously resolvable and natively reactive.
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

  const isPrimary = createMemo(
    () => props.primaryThreadUrl() === props.threadUrl
  );
  const isSecondary = createMemo(() =>
    props.secondaryThreadUrls().has(props.threadUrl)
  );

  const onClickThreadCard = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("textarea, button, input, a, select")) return;
    const t = thread();
    if (!t) return;
    props.onSelectThread(props.threadUrl, t.refs);
  };

  // `thread().comments` is a fresh Automerge proxy every change; returning
  // the previous array when the id sequence is unchanged keeps <For> from
  // tearing down focused draft textareas on each keystroke.
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

  // TODO: better way to get the contactUrl of the current account.
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
    return r.docHandle.ref("@comments", "threads", { id: t.id }, "comments", {
      id: d.id,
    });
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
        <div
          class={`card card-bordered bg-white border border-gray-300 transition-all cursor-pointer ${
            isPrimary()
              ? "shadow-xl"
              : isSecondary()
                ? "shadow-md"
                : "shadow-sm"
          }`}
          onClick={onClickThreadCard}
        >
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
        <Show when={draftComment() || isPrimary()}>
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
        </Show>
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
