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
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";

import {
  subscribeDoc,
  subscribe,
} from "@inkandswitch/patchwork-providers-solid";
import { createReply, type Comment, type CommentThread } from "./comments";

const VERSION = "v2.3.11-comments";

export function CommentsView(props: { element: HTMLElement }) {
  const repo = useRepo();

  const commentEntries = subscribe<
    { targetUrl: AutomergeUrl; threadUrl: AutomergeUrl }[]
  >(props.element, { type: "patchwork:comments" }, []);

  // `selection` is read-only input (driven by the active editor), `highlight`
  // is our output. Splitting them avoids the feedback loop a single shared
  // map would have.
  const [focusDoc, focusHandle] = subscribeDoc<{
    selection: Record<AutomergeUrl, true>;
    highlight: Record<AutomergeUrl, true>;
  }>(props.element, { type: "patchwork:focus" });

  const [, contactHandle] = subscribeDoc<Record<string, never>>(props.element, {
    type: "patchwork:contact",
  });
  const currentContactUrl = () =>
    contactHandle()?.url as AutomergeUrl | undefined;

  const threadUrls = createMemo<AutomergeUrl[]>(() => {
    const entries = commentEntries();
    const threadUrls = new Set<AutomergeUrl>();
    for (const { threadUrl } of entries) {
      threadUrls.add(threadUrl);
    }
    return Array.from(threadUrls);
  });

  const threadTargetUrlMap = createMemo<Map<AutomergeUrl, AutomergeUrl[]>>(
    () => {
      const entries = commentEntries();
      const map = new Map<AutomergeUrl, AutomergeUrl[]>();
      for (const { targetUrl, threadUrl } of entries) {
        const existing = map.get(threadUrl);
        if (existing) {
          if (!existing.includes(targetUrl)) existing.push(targetUrl);
        } else {
          map.set(threadUrl, [targetUrl]);
        }
      }
      return map;
    }
  );

  const selectedHandles = useResolvedHandles(
    () => Object.keys(focusDoc()?.selection ?? {}) as AutomergeUrl[],
    repo
  );

  const threadTargetHandleMap = useResolvedHandleMap(threadTargetUrlMap, repo);

  const overlappingThreads = createMemo<AutomergeUrl[]>(() =>
    threadUrls().filter((url) =>
      threadOverlapsSelection(
        threadTargetHandleMap().get(url) ?? [],
        selectedHandles()
      )
    )
  );

  // Tiebreaker for when several threads share the same range — without it
  // the second of two threads on the same target would be unselectable.
  const [pinnedThread, setPinnedThread] = createSignal<
    AutomergeUrl | undefined
  >();

  const primaryThreadUrl = createMemo<AutomergeUrl | undefined>(() => {
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
    const desired: Record<AutomergeUrl, true> = {};
    for (const u of urls) desired[u] = true;
    handle.change((doc) => {
      doc.highlight = desired;
    });
  });

  // Clicking a thread card pins it and jumps `selection` to its targets;
  // the editor's next cursor move will overwrite `selection` again.
  const onSelectThread = (
    threadUrl: AutomergeUrl,
    targetUrls: AutomergeUrl[]
  ) => {
    const handle = focusHandle();
    if (!handle) return;
    const wasPrimary = primaryThreadUrl() === threadUrl;
    setPinnedThread(wasPrimary ? undefined : threadUrl);
    const next: Record<AutomergeUrl, true> = {};
    if (!wasPrimary) for (const u of targetUrls) next[u] = true;
    handle.change((doc) => {
      doc.selection = next;
    });
  };

  onCleanup(() => {
    const handle = focusHandle();
    if (!handle) return;
    handle.change((doc) => {
      doc.highlight = {} as Record<AutomergeUrl, true>;
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
            currentContactUrl={currentContactUrl}
          />
        )}
      </For>
    </div>
  );
}

// Reactively resolve a list of urls into live sub-handles. Re-resolves
// whenever the url list changes; resolution is async (`repo.find`) so the
// accessor lags one tick behind the urls.
function useResolvedHandles(
  urls: () => AutomergeUrl[],
  repo: Repo
): () => DocHandle<unknown>[] {
  const [handles, setHandles] = createSignal<DocHandle<unknown>[]>([]);
  createEffect(() => {
    const list = urls();
    let cancelled = false;
    Promise.all(list.map((u) => repo.find(u).catch(() => undefined))).then(
      (resolved) => {
        if (cancelled) return;
        setHandles(resolved.filter((h): h is DocHandle<unknown> => Boolean(h)));
      }
    );
    onCleanup(() => {
      cancelled = true;
    });
  });
  return handles;
}

// Same as `useResolvedHandles` but for a keyed map of url lists.
function useResolvedHandleMap(
  map: () => Map<AutomergeUrl, AutomergeUrl[]>,
  repo: Repo
): () => Map<AutomergeUrl, DocHandle<unknown>[]> {
  const [resolved, setResolved] = createSignal<
    Map<AutomergeUrl, DocHandle<unknown>[]>
  >(new Map());
  createEffect(() => {
    const m = map();
    let cancelled = false;
    void (async () => {
      const out = new Map<AutomergeUrl, DocHandle<unknown>[]>();
      for (const [key, urls] of m) {
        const handles = await Promise.all(
          urls.map((u) => repo.find(u).catch(() => undefined))
        );
        out.set(
          key,
          handles.filter((h): h is DocHandle<unknown> => Boolean(h))
        );
      }
      if (!cancelled) setResolved(out);
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });
  return resolved;
}

function threadOverlapsSelection(
  targets: DocHandle<unknown>[],
  selection: DocHandle<unknown>[]
): boolean {
  return targets.some((t) => selection.some((s) => s.overlaps(t)));
}

function ThreadView(props: {
  threadUrl: AutomergeUrl;
  repo: Repo;
  primaryThreadUrl: () => AutomergeUrl | undefined;
  secondaryThreadUrls: () => Set<AutomergeUrl>;
  onSelectThread: (threadUrl: AutomergeUrl, targetUrls: AutomergeUrl[]) => void;
  currentContactUrl: () => AutomergeUrl | undefined;
}) {
  // Subdoc handles resolve asynchronously via `repo.find`, so drive the
  // handle through a signal seeded once the find resolves.
  const [threadHandle, setThreadHandle] = createSignal<
    DocHandle<CommentThread> | undefined
  >(undefined);

  createEffect(() => {
    let cancelled = false;
    setThreadHandle(() => undefined);
    props.repo
      .find<CommentThread>(props.threadUrl)
      .then((handle) => {
        if (cancelled) return;
        setThreadHandle(() => handle);
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
    const h = threadHandle();
    if (!h) {
      setThread(() => undefined);
      return;
    }
    setThread(() => h.doc());
    const onChange = () => setThread(() => h.doc());
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
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
    props.onSelectThread(props.threadUrl, t.refs as AutomergeUrl[]);
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

  const draftComment = createMemo(() => {
    const t = thread();
    if (!t) return undefined;
    return t.comments.find(
      (c) => c.draftContent !== undefined || c.content === undefined
    );
  });

  const draftCommentHandle = createMemo(() => {
    const h = threadHandle();
    const t = thread();
    const d = draftComment();
    if (!h || !t || !d) return undefined;
    return h.sub("comments", { id: d.id }) as DocHandle<Comment>;
  });

  const onResolveThread = () => {
    const h = threadHandle();
    if (!h) return;
    h.change((t) => {
      t.isResolved = true;
    });
  };

  const onReplyToComment = () => {
    const handle = threadHandle();
    const contactUrl = props.currentContactUrl();
    if (!handle || !contactUrl) return;
    createReply({ threadHandle: handle, content: "", contactUrl });
  };

  const onDeleteComment = (commentHandle: DocHandle<Comment>) => {
    const h = threadHandle();
    commentHandle.remove();
    if (h?.doc()?.comments.length === 0) {
      h.remove();
    }
  };

  const onSaveDraft = () => {
    const h = draftCommentHandle();
    if (!h) return;
    h.change((comment: Comment) => {
      comment.content = comment.draftContent;
      comment.timestamp = Date.now();
      delete comment.draftContent;
    });
  };

  const onCancelDraft = () => {
    const h = draftCommentHandle();
    if (!h) return;
    const commentValue = h.doc() as Comment | undefined;
    if (commentValue?.content === undefined) {
      onDeleteComment(h);
      return;
    }
    h.change((comment: Comment) => {
      delete comment.draftContent;
    });
  };

  return (
    <Show when={thread() && threadHandle()}>
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
                const commentHandle = createMemo(() => {
                  const handle = threadHandle();
                  const t = thread();
                  if (!handle || !t) return undefined;
                  return handle.sub("comments", {
                    id: commentId,
                  }) as DocHandle<Comment>;
                });
                return (
                  <Show when={commentHandle()}>
                    {(handle) => (
                      <CommentView
                        commentHandle={handle()}
                        currentContactUrl={props.currentContactUrl()}
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
  commentHandle: DocHandle<Comment>;
  currentContactUrl?: string;
  repo: Repo;
}) {
  const [comment, setComment] = createSignal<Comment | undefined>(undefined);
  createEffect(() => {
    const h = props.commentHandle;
    setComment(() => h.doc() as Comment | undefined);
    const onChange = () => setComment(() => h.doc() as Comment | undefined);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
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
    props.commentHandle.change((c: Comment) => {
      c.draftContent = newDraftContent;
    });
  };

  return (
    <Show when={shouldRender() && comment()}>
      <div class="space-y-2" data-id={props.commentHandle.url}>
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
