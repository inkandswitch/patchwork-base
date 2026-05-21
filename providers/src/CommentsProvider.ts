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

export const CommentsProvider = (element: HTMLElement) => {
  const repo = (window as unknown as { repo?: Repo }).repo;
  if (!repo) {
    console.warn("[providers] window.repo is not set; comments disabled");
    return () => {};
  }

  // Map of targetRef to threadRefs that reference it.
  const aggregate = repo.create<Record<RefUrl, RefUrl[]>>({});
  const commentsByDocHandle = new Map<
    DocHandle<DocWithComments>,
    Record<RefUrl, RefUrl[]>
  >();

  const buildCommentsForDoc = (
    handle: DocHandle<DocWithComments>
  ): Record<RefUrl, RefUrl[]> => {
    const comments = {} as Record<RefUrl, RefUrl[]>;
    const threads = handle.doc()?.["@comments"]?.threads ?? [];
    for (const thread of threads) {
      if (thread.isResolved) continue;
      const threadRefUrl = handle.ref("@comments", "threads", {
        id: thread.id,
      }).url;
      for (const targetRefUrl of thread.refs) {
        (comments[targetRefUrl] ??= []).push(threadRefUrl);
      }
    }
    return comments;
  };

  const rebuildAggregate = () => {
    aggregate.change((doc) => {
      const map = doc as Record<string, RefUrl[]>;
      for (const k of Object.keys(map)) delete map[k];
      for (const comments of commentsByDocHandle.values()) {
        for (const [targetRef, threadRefs] of Object.entries(comments)) {
          map[targetRef] = [...(map[targetRef] ?? []), ...threadRefs];
        }
      }
    });
  };

  const onChange = ({ handle }: DocHandleChangePayload<DocWithComments>) => {
    commentsByDocHandle.set(handle, buildCommentsForDoc(handle));
    rebuildAggregate();
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
    commentsByDocHandle.set(handle, buildCommentsForDoc(handle));
    rebuildAggregate();
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
    provide(event, aggregate as DocHandle<unknown>);
  };
  element.addEventListener("patchwork:request", onRequest);

  return () => {
    element.removeEventListener("patchwork:mounted", onMounted);
    element.removeEventListener("patchwork:request", onRequest);
    for (const handle of commentsByDocHandle.keys()) {
      handle.off("change", onChange);
    }
    aggregate.delete();
  };
};
