import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import {
  provide,
  request,
  type RequestEvent,
} from "@inkandswitch/patchwork-providers";

import type {
  DraftDoc,
  DraftsState,
  HasDraftMarker,
} from "../draft-types.js";

const REQ_HOST_DOC = "patchwork:host-doc";
const REQ_HOST_REPO = "patchwork:host-repo";
const REQ_DRAFT_ROOT = "patchwork:draft-root";
const REQ_DRAFTS = "patchwork:drafts";

const ATTR_DOC_URL = "doc-url";

// Outer provider. Mounts on a document URL and exposes that document's
// per-doc draft tree:
//   - `patchwork:host-doc`   → DocHandle of the doc this provider is on
//   - `patchwork:host-repo`  → root Repo (so consumers can write outside COW)
//   - `patchwork:draft-root` → DocHandle<DraftDoc> of the root draft, or null
//                              when the doc has no drafts yet
//   - `patchwork:drafts`     → DocHandle<DraftsState>, or null when empty
//
// `@patchwork.draftUrl` is the link from a doc to its root draft. It is
// lazily created by the drafts sidebar on the first "New draft" action;
// absence means "no drafts for this doc".
export const DraftRootProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute(ATTR_DOC_URL);
  if (!rawUrl || !isValidAutomergeUrl(rawUrl)) {
    console.warn(
      `[drafts] <patchwork-view component="patchwork-draft-root-provider"> ` +
        `is missing a valid ${ATTR_DOC_URL} attribute (got ${JSON.stringify(rawUrl)})`
    );
    return () => {};
  }
  const docUrl: AutomergeUrl = rawUrl;

  let repo: Repo | null = null;
  let hostDocHandle: DocHandle<HasDraftMarker> | null = null;
  let rootDraftHandle: DocHandle<DraftDoc> | null = null;
  let draftsStateHandle: DocHandle<DraftsState> | null = null;
  const trackedDrafts = new Map<AutomergeUrl, DocHandle<DraftDoc>>();

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  const onTrackedChange = () => scheduleRewalk();
  const onHostDocChange = () => scheduleHostDocReconcile();
  let lastSeenDraftUrl: AutomergeUrl | null | undefined = undefined;

  const ready: Promise<DocHandle<HasDraftMarker>> = (async () => {
    const r = await request<Repo>(element, "patchwork:repo");
    if (!r) {
      throw new Error(
        "[drafts] no `patchwork:repo` provider found; draft-root provider disabled"
      );
    }
    repo = r;

    const handle = await repo.find<HasDraftMarker>(docUrl);
    await handle.whenReady();
    if (disposed) throw new Error("[drafts] provider disposed mid-load");
    hostDocHandle = handle;
    handle.on("change", onHostDocChange);

    await reconcileRootFromHostDoc();
    return handle;
  })();
  ready.catch((err) => {
    console.error(`[drafts] failed to initialize draft-root provider:`, err);
  });

  const onRequest = (event: RequestEvent) => {
    const { type } = event.detail;

    if (type === REQ_HOST_DOC) {
      provide<DocHandle<HasDraftMarker>>(
        event,
        hostDocHandle ?? ready
      );
      return;
    }

    if (type === REQ_HOST_REPO) {
      provide<Repo>(event, repo ?? ready.then(() => repo!));
      return;
    }

    if (type === REQ_DRAFT_ROOT) {
      provide<DocHandle<DraftDoc> | null>(
        event,
        rootDraftHandle ?? ready.then(() => rootDraftHandle)
      );
      return;
    }

    if (type === REQ_DRAFTS) {
      provide<DocHandle<DraftsState> | null>(
        event,
        draftsStateHandle ?? ready.then(() => draftsStateHandle)
      );
      return;
    }
  };

  element.addEventListener("patchwork:request", onRequest);

  return () => {
    disposed = true;
    element.removeEventListener("patchwork:request", onRequest);
    if (hostDocHandle) hostDocHandle.off("change", onHostDocChange);
    for (const [, h] of trackedDrafts) h.off("change", onTrackedChange);
    trackedDrafts.clear();
    if (draftsStateHandle && repo) {
      repo.delete(draftsStateHandle.url);
    }
    draftsStateHandle = null;
    rootDraftHandle = null;
    hostDocHandle = null;
  };

  async function reconcileRootFromHostDoc(): Promise<void> {
    if (!repo || !hostDocHandle) return;
    const draftUrl = hostDocHandle.doc()?.["@patchwork"]?.draftUrl;
    const next: AutomergeUrl | null =
      draftUrl && isValidAutomergeUrl(draftUrl) ? draftUrl : null;

    if (next === lastSeenDraftUrl) return;
    lastSeenDraftUrl = next;

    // Tear down any previous draft tree state.
    for (const [, h] of trackedDrafts) h.off("change", onTrackedChange);
    trackedDrafts.clear();
    if (draftsStateHandle) {
      repo.delete(draftsStateHandle.url);
      draftsStateHandle = null;
    }
    rootDraftHandle = null;

    if (!next) return;

    const root = await repo.find<DraftDoc>(next);
    await root.whenReady();
    if (disposed || lastSeenDraftUrl !== next) return;
    rootDraftHandle = root;

    const allDrafts = await collectAllDrafts(repo, root.url, trackedDrafts);
    if (disposed || lastSeenDraftUrl !== next) return;

    draftsStateHandle = repo.create<DraftsState>({
      drafts: allDrafts,
      selectedDraft: root.url,
    });
    for (const [, h] of trackedDrafts) h.on("change", onTrackedChange);
  }

  function scheduleHostDocReconcile(): void {
    if (disposed) return;
    void reconcileRootFromHostDoc().catch((err) => {
      console.error("[drafts] reconcile failed:", err);
    });
  }

  function scheduleRewalk(): void {
    if (disposed) return;
    if (!repo) return;
    if (rewalkInFlight) {
      rewalkPending = true;
      return;
    }
    rewalkInFlight = true;
    const liveRepo = repo;
    void (async () => {
      try {
        if (!rootDraftHandle || !draftsStateHandle) return;
        const allDrafts = await collectAllDrafts(
          liveRepo,
          rootDraftHandle.url,
          trackedDrafts,
          onTrackedChange
        );
        if (disposed || !draftsStateHandle) return;
        const current = draftsStateHandle.doc()?.drafts ?? [];
        if (sameUrlList(current, allDrafts)) return;
        draftsStateHandle.change((d) => {
          d.drafts = allDrafts;
        });
      } catch (err) {
        console.error("[drafts] rewalk failed:", err);
      } finally {
        rewalkInFlight = false;
        if (rewalkPending) {
          rewalkPending = false;
          scheduleRewalk();
        }
      }
    })();
  }
};

async function collectAllDrafts(
  repo: Repo,
  rootUrl: AutomergeUrl,
  tracked: Map<AutomergeUrl, DocHandle<DraftDoc>>,
  onNewChange?: () => void
): Promise<AutomergeUrl[]> {
  const visited = new Set<AutomergeUrl>();
  const order: AutomergeUrl[] = [];
  const queue: AutomergeUrl[] = [rootUrl];
  while (queue.length) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    order.push(url);

    let h = tracked.get(url);
    if (!h) {
      h = await repo.find<DraftDoc>(url);
      await h.whenReady();
      tracked.set(url, h);
      if (onNewChange) h.on("change", onNewChange);
    }
    const drafts = h.doc()?.drafts ?? [];
    for (const child of drafts) {
      if (isValidAutomergeUrl(child)) queue.push(child);
    }
  }
  return order;
}

function sameUrlList(a: readonly AutomergeUrl[], b: readonly AutomergeUrl[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
