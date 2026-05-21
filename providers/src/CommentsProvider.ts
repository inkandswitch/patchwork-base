import {
  type AutomergeUrl,
  type DocHandle,
  type DocHandleChangePayload,
  type RefUrl,
  type Repo,
} from "@automerge/automerge-repo";
import {
  provide,
  type RequestEvent,
} from "@inkandswitch/patchwork-providers";
import type { DocWithComments } from "@inkandswitch/patchwork-comments";

const SELECTOR = "patchwork:comments";

type CommentEntry = { targetRef: RefUrl; threadRef: RefUrl };

const entriesEqual = (a: CommentEntry, b: CommentEntry) =>
  a.targetRef === b.targetRef && a.threadRef === b.threadRef;

export const CommentsProvider = (element: HTMLElement) => {
  const repo = (window as unknown as { repo?: Repo }).repo;
  if (!repo) {
    console.warn("[providers] window.repo is not set; comments disabled");
    return () => {};
  }

  const allComments = repo.create<{ comments: CommentEntry[] }>({
    comments: [],
  });
  const commentsByDocHandle = new Map<
    DocHandle<DocWithComments>,
    CommentEntry[]
  >();

  const buildEntriesForDoc = (
    handle: DocHandle<DocWithComments>
  ): CommentEntry[] => {
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
  };

  // We mutate `doc.comments` in place (pop trailing entries, write fields
  // on existing entries, push new ones) instead of replacing the array or
  // deleting map keys. This is a workaround for a bug in the automerge
  // solid bindings: their bundled `applyDelPatch` throws
  // `RangeError: index is not a number for patch` whenever a `del` patch
  // arrives with a non-numeric path, so we have to keep every delete as a
  // numeric array operation.
  const rebuildAllComments = () => {
    const next: CommentEntry[] = [];
    for (const docEntries of commentsByDocHandle.values()) {
      for (const entry of docEntries) next.push(entry);
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
  };

  const onChange = ({ handle }: DocHandleChangePayload<DocWithComments>) => {
    commentsByDocHandle.set(handle, buildEntriesForDoc(handle));
    rebuildAllComments();
  };

  const watch = async (url: AutomergeUrl) => {
    let handle: DocHandle<DocWithComments>;
    try {
      handle = await repo.find<DocWithComments>(url);
    } catch (error) {
      console.error(`[providers] failed to watch comments on ${url}`, error);
      return;
    }
    if (commentsByDocHandle.has(handle)) return;

    handle.on("change", onChange);
    commentsByDocHandle.set(handle, buildEntriesForDoc(handle));
    rebuildAllComments();
  };

  const onMounted = (event: Event) => {
    const detail = (
      event as CustomEvent<{ url?: AutomergeUrl; componentId?: string }>
    ).detail;
    if (!detail?.url) return;
    watch(detail.url);
  };
  element.addEventListener("patchwork:mounted", onMounted);

  const onRequest = (event: RequestEvent) => {
    if (event.detail.type !== SELECTOR) return;
    provide(event, allComments as DocHandle<unknown>);
  };
  element.addEventListener("patchwork:request", onRequest);

  return () => {
    element.removeEventListener("patchwork:mounted", onMounted);
    element.removeEventListener("patchwork:request", onRequest);
    for (const handle of commentsByDocHandle.keys()) {
      handle.off("change", onChange);
    }
    allComments.delete();
  };
};
