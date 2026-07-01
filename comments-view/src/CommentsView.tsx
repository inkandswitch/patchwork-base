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

import { useRepo } from "@automerge/automerge-repo-solid-primitives";
import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";

import {
  subscribeDoc,
  subscribe,
} from "@inkandswitch/patchwork-providers-solid";
import {
  createDocumentThread,
  type DocWithComments,
} from "./comments";

export function CommentsView(props: { element: HTMLElement }) {
  const repo = useRepo();

  const commentEntries = subscribe<
    { targetUrl: AutomergeUrl; threadUrl: AutomergeUrl }[]
  >(props.element, { type: "patchwork:comments" }, []);

  // The doc to attach untargeted (document-level) comments to: whatever is
  // currently selected in the main view.
  const selectedDocUrls = subscribe<AutomergeUrl[]>(
    props.element,
    { type: "patchwork:selected-doc" },
    []
  );
  const targetDocUrl = () => selectedDocUrls()[0] as AutomergeUrl | undefined;

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

  // A thread is only worth showing if at least one of its targets still
  // resolves to a real, non-empty span. Targets that resolve to an empty
  // string (a collapsed range) or an undefined value (an anchor that no
  // longer resolves) are excluded — see `targetIsVisible`.
  const threadsWithVisibleTarget = useThreadsWithVisibleTarget(
    threadTargetUrlMap,
    repo
  );

  const renderableThreadUrls = createMemo<AutomergeUrl[]>(() =>
    threadUrls().filter((url) => threadsWithVisibleTarget().has(url))
  );

  // Document-level threads target the whole document (a bare url, no `/` path
  // or `#` heads), so they have no resolvable range and never pass the
  // visible-target filter. They should always be listed regardless.
  const docLevelThreadUrls = createMemo<Set<AutomergeUrl>>(() => {
    const map = threadTargetUrlMap();
    const set = new Set<AutomergeUrl>();
    for (const [threadUrl, targets] of map) {
      if (
        targets.length > 0 &&
        targets.every((t) => !t.includes("/") && !t.includes("#"))
      ) {
        set.add(threadUrl);
      }
    }
    return set;
  });

  // What the panel actually renders: ranged threads whose target is still
  // visible, plus all document-level threads.
  const displayedThreadUrls = createMemo<AutomergeUrl[]>(() =>
    threadUrls().filter(
      (url) =>
        threadsWithVisibleTarget().has(url) || docLevelThreadUrls().has(url)
    )
  );

  const overlappingThreads = createMemo<AutomergeUrl[]>(() =>
    renderableThreadUrls().filter((url) =>
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

  // Card clicks bubble up from the thread tool. Ignore clicks on interactive
  // controls (its buttons / draft textarea) so they don't also select.
  const onClickThreadCard = (e: MouseEvent, threadUrl: AutomergeUrl) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("textarea, button, input, a, select")) return;
    onSelectThread(threadUrl, threadTargetUrlMap().get(threadUrl) ?? []);
  };

  // The selection state we hand each thread tool via `data-thread-state`.
  const threadState = (threadUrl: AutomergeUrl): string =>
    primaryThreadUrl() === threadUrl
      ? "primary"
      : secondaryThreadUrls().has(threadUrl)
        ? "secondary"
        : "inactive";

  onCleanup(() => {
    const handle = focusHandle();
    if (!handle) return;
    handle.change((doc) => {
      doc.highlight = {} as Record<AutomergeUrl, true>;
    });
  });

  const canAddComment = () =>
    Boolean(targetDocUrl()) && Boolean(currentContactUrl());

  const onAddComment = async () => {
    const url = targetDocUrl();
    const contactUrl = currentContactUrl();
    if (!url || !contactUrl) return;
    const handle = await repo.find<DocWithComments>(url);
    createDocumentThread({ docHandle: handle, contactUrl });
  };

  return (
    <div class="comments-panel">
      <div class="comments-panel-header">
        <span class="comments-panel-header-title">Comments</span>
        <Show when={canAddComment()}>
          <button
            class="comment-btn"
            onClick={onAddComment}
            title="Comment on this document"
          >
            Add comment
          </button>
        </Show>
      </div>
      <Show
        when={displayedThreadUrls().length > 0}
        fallback={<div class="comments-empty">No comments yet</div>}
      >
        <For each={displayedThreadUrls()}>
          {(threadUrl) => (
            <div
              class="comments-thread"
              onClick={(e) => onClickThreadCard(e, threadUrl)}
            >
              <patchwork-view
                doc-url={threadUrl}
                tool-id="comment-thread"
                attr:data-thread-state={threadState(threadUrl)}
              />
            </div>
          )}
        </For>
      </Show>
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

// Resolves each thread's target urls into live span handles and reports which
// threads have at least one visible target. Re-runs when the url map changes,
// and recomputes live when any resolved target doc changes — so a thread whose
// commented text gets deleted disappears without waiting for a re-resolve.
function useThreadsWithVisibleTarget(
  map: () => Map<AutomergeUrl, AutomergeUrl[]>,
  repo: Repo
): () => Set<AutomergeUrl> {
  const [visible, setVisible] = createSignal<Set<AutomergeUrl>>(new Set());
  createEffect(() => {
    const m = map();
    let cancelled = false;
    let resolved = new Map<AutomergeUrl, DocHandle<unknown>[]>();

    const recompute = () => {
      if (cancelled) return;
      const next = new Set<AutomergeUrl>();
      for (const [threadUrl, handles] of resolved) {
        if (handles.some(targetIsVisible)) next.add(threadUrl);
      }
      setVisible(next);
    };

    void (async () => {
      const out = new Map<AutomergeUrl, DocHandle<unknown>[]>();
      for (const [threadUrl, urls] of m) {
        const handles = await Promise.all(
          urls.map((u) => repo.find(u).catch(() => undefined))
        );
        out.set(
          threadUrl,
          handles.filter((h): h is DocHandle<unknown> => Boolean(h))
        );
      }
      if (cancelled) return;
      resolved = out;
      for (const h of flatHandles(resolved)) h.on("change", recompute);
      recompute();
    })();

    onCleanup(() => {
      cancelled = true;
      for (const h of flatHandles(resolved)) h.off("change", recompute);
    });
  });
  return visible;
}

function flatHandles(
  map: Map<AutomergeUrl, DocHandle<unknown>[]>
): DocHandle<unknown>[] {
  const out: DocHandle<unknown>[] = [];
  for (const handles of map.values()) out.push(...handles);
  return out;
}

// A target "points to" a real value only when its anchored range still
// resolves (`rangePositions` is defined) and spans at least one character
// (`start !== end`). A missing range is an undefined value (the anchor no
// longer resolves); an empty range is an empty string (the commented text was
// deleted). Mirrors `buildCommentDecorations` in the codemirror tool.
function targetIsVisible(handle: DocHandle<unknown>): boolean {
  const positions = handle.rangePositions();
  if (!positions) return false;
  const [start, end] = positions;
  return start !== end;
}

function threadOverlapsSelection(
  targets: DocHandle<unknown>[],
  selection: DocHandle<unknown>[]
): boolean {
  return targets.some((t) => selection.some((s) => s.overlaps(t)));
}

