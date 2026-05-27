import {
  type AutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type DocHandleDeletePayload,
  type RefUrl,
  type Repo,
} from "@automerge/automerge-repo";
import {
  provide,
  type RequestEvent,
} from "@inkandswitch/patchwork-providers";
import type {
  MountedEvent,
  UnmountedEvent,
} from "@inkandswitch/patchwork-elements";
import type { DocWithComments } from "@inkandswitch/patchwork-comments";


type CommentEntry = { targetRef: RefUrl; threadRef: RefUrl };

export const CommentsProvider = (element: HTMLElement) => {
  const repo = (window as unknown as { repo?: Repo }).repo;
  if (!repo) {
    console.warn("[providers/comments] window.repo is not set; comments disabled");
    return () => { };
  }


  // this is just a temporary document, we use a real doc handle here so we 
  // don't need to invent something new. Eventually it would be nice to have
  // a more generic solution for reactive values
  const allComments = repo.create<{ comments: CommentEntry[] }>({
    comments: [],
  });

  // Synchronous source of truth; survives the `await repo.find` below.
  const mountCounts = new Map<AutomergeUrl, number>();
  const handlesByUrl = new Map<AutomergeUrl, DocHandle<DocWithComments>>();
  const commentsByDocUrl = new Map<AutomergeUrl, CommentEntry[]>();

  element.addEventListener("patchwork:mounted", startWatch);
  element.addEventListener("patchwork:unmounted", stopWatch);
  element.addEventListener("patchwork:request", onRequest);

  return () => {
    element.removeEventListener("patchwork:mounted", startWatch);
    element.removeEventListener("patchwork:unmounted", stopWatch);
    element.removeEventListener("patchwork:request", onRequest);
    for (const url of [...handlesByUrl.keys()]) disposeDoc(url);
    allComments.delete();
  };

  async function startWatch(event: MountedEvent) {
    if (!("url" in event.detail)) return;
    const url = event.detail.url;
    const wasMounted = isMounted(url);
    mountDoc(url);
    if (wasMounted) return;

    let handle: DocHandle<DocWithComments>;
    try {
      handle = await repo!.find<DocWithComments>(url);
    } catch (error) {
      console.error(`[providers] failed to watch comments on ${url}`, error);
      return;
    }
    if (!isMounted(url)) return;
    if (handlesByUrl.has(url)) return;

    handle.on("change", onChange);
    handle.on("delete", onDelete);
    handlesByUrl.set(url, handle);
    commentsByDocUrl.set(url, buildEntriesForDoc(handle));
    rebuildAllComments();
  }

  function stopWatch(event: UnmountedEvent) {
    if (!("url" in event.detail)) return;
    const url = event.detail.url;
    unmountDoc(url);
    if (!isMounted(url)) disposeDoc(url);
  }

  function onRequest(event: RequestEvent) {
    if (event.detail.type !== "patchwork:comments") return;
    provide(event, allComments as DocHandle<unknown>);
  }

  function onChange({ handle }: DocHandleChangePayload<DocWithComments>) {
    const prev = commentsByDocUrl.get(handle.url);
    if (!prev) return;
    const next = buildEntriesForDoc(handle);
    if (entryListsEqual(prev, next)) return;
    commentsByDocUrl.set(handle.url, next);
    rebuildAllComments();
  }

  function onDelete({ handle }: DocHandleDeletePayload<DocWithComments>) {
    disposeDoc(handle.url);
  }

  function disposeDoc(url: AutomergeUrl) {
    const handle = handlesByUrl.get(url);
    mountCounts.delete(url);
    handlesByUrl.delete(url);
    commentsByDocUrl.delete(url);
    if (!handle) return;
    handle.off("change", onChange);
    handle.off("delete", onDelete);
    rebuildAllComments();
  }

  function buildEntriesForDoc(
    handle: DocHandle<DocWithComments>
  ): CommentEntry[] {
    const entries: CommentEntry[] = [];
    const threads = handle.doc()?.["@comments"]?.threads ?? [];
    for (const thread of threads) {
      if (thread.isResolved) continue;
      const threadRef = handle.ref("@comments", "threads", {
        id: thread.id,
      }).url;
      for (const targetRef of thread.refs) {
        entries.push({ targetRef, threadRef });
      }
    }
    return entries;
  }

  // In-place mutation only: the automerge-solid bindings throw on `del`
  // patches with non-numeric paths, so every removal must be an array pop.
  function rebuildAllComments() {
    const next: CommentEntry[] = [];
    for (const entries of commentsByDocUrl.values()) {
      for (const entry of entries) next.push(entry);
    }
    allComments.change((doc) => {
      while (doc.comments.length > next.length) doc.comments.pop();
      for (let i = 0; i < next.length; i++) {
        if (i < doc.comments.length) {
          const cur = doc.comments[i];
          if (!entriesEqual(cur, next[i])) {
            if (cur.targetRef !== next[i].targetRef) {
              cur.targetRef = next[i].targetRef;
            }
            if (cur.threadRef !== next[i].threadRef) {
              cur.threadRef = next[i].threadRef;
            }
          }
        } else {
          doc.comments.push(next[i]);
        }
      }
    });
  }

  function mountDoc(url: AutomergeUrl) {
    mountCounts.set(url, (mountCounts.get(url) ?? 0) + 1);
  }

  function unmountDoc(url: AutomergeUrl) {
    const cur = mountCounts.get(url) ?? 0;
    if (cur <= 1) mountCounts.delete(url);
    else mountCounts.set(url, cur - 1);
  }

  function isMounted(url: AutomergeUrl) {
    return mountCounts.has(url);
  }
};

const entriesEqual = (a: CommentEntry, b: CommentEntry) =>
  a.targetRef === b.targetRef && a.threadRef === b.threadRef;

const entryListsEqual = (a: CommentEntry[], b: CommentEntry[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!entriesEqual(a[i], b[i])) return false;
  }
  return true;
};
