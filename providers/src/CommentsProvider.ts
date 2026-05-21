import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import {
  provide,
  type RequestEvent,
} from "@inkandswitch/patchwork-providers";

export type CommentsDoc = Record<AutomergeUrl, true>;

const SELECTOR = "patchwork:comments";

export const CommentsProvider = (element: HTMLElement) => {
  const repo = (window as unknown as { repo?: Repo }).repo;
  if (!repo) {
    console.warn("[providers] window.repo is not set; comments disabled");
    return () => {};
  }

  const handle: DocHandle<CommentsDoc> = repo.create<CommentsDoc>({});

  const onMounted = (event: Event) => {
    const url = (event as CustomEvent<{ url?: AutomergeUrl }>).detail?.url;
    if (!url) return;
    if (handle.doc()?.[url]) return;
    handle.change((doc) => {
      doc[url] = true;
    });
  };
  element.addEventListener("patchwork:mounted", onMounted);

  const stopProviding = provide(element, (event: RequestEvent) => {
    if (event.detail.type !== SELECTOR) return undefined;
    return handle as DocHandle<unknown>;
  });

  return () => {
    element.removeEventListener("patchwork:mounted", onMounted);
    stopProviding();
    handle.delete();
  };
};
