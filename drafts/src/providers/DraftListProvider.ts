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
  HasDrafts,
} from "../draft-types.js";

const REQ_HOST_DOC = "patchwork:host-doc";
const REQ_HOST_REPO = "patchwork:host-repo";
const REQ_DRAFTS = "patchwork:drafts";

const ATTR_DOC_URL = "doc-url";

// Mounts on a document URL and exposes that document's per-doc draft list:
//   - `patchwork:host-doc`   → DocHandle of the doc this provider is on
//   - `patchwork:host-repo`  → root Repo (so consumers can write outside COW)
//   - `patchwork:drafts`     → DocHandle<DraftsState>, always available
//
// The link from a host doc to its drafts is `@patchwork.drafts`, an array
// of `DraftDoc` URLs that branch off of it. A `DraftDoc` may have its own
// sub-drafts via `DraftDoc.drafts`. `DraftsState.selectedDraft = null`
// represents "main" — i.e. the host doc itself, no overlay.
export const DraftListProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute(ATTR_DOC_URL);
  if (!rawUrl || !isValidAutomergeUrl(rawUrl)) {
    console.warn(
      `[drafts] <patchwork-view component="patchwork-draft-list-provider"> ` +
        `is missing a valid ${ATTR_DOC_URL} attribute (got ${JSON.stringify(rawUrl)})`
    );
    return () => {};
  }
  const docUrl: AutomergeUrl = rawUrl;

  let repo: Repo | null = null;
  let hostDocHandle: DocHandle<HasDrafts> | null = null;
  let draftsStateHandle: DocHandle<DraftsState> | null = null;
  const trackedDrafts = new Map<AutomergeUrl, DocHandle<DraftDoc>>();

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  const onTrackedChange = () => scheduleRewalk();
  const onHostDocChange = () => scheduleRewalk();

  const ready: Promise<DocHandle<HasDrafts>> = (async () => {
    const r = await request<Repo>(element, "patchwork:repo");
    if (!r) {
      throw new Error(
        "[drafts] no `patchwork:repo` provider found; draft-list provider disabled"
      );
    }
    repo = r;

    const handle = await repo.find<HasDrafts>(docUrl);
    await handle.whenReady();
    if (disposed) throw new Error("[drafts] provider disposed mid-load");
    hostDocHandle = handle;

    // Eagerly create the ephemeral DraftsState so the sidebar can render
    // its "Main" card and write `selectedDraft` even before any drafts
    // exist on the host doc.
    draftsStateHandle = repo.create<DraftsState>({
      drafts: [],
      selectedDraft: null,
    });

    handle.on("change", onHostDocChange);
    scheduleRewalk();
    return handle;
  })();
  ready.catch((err) => {
    console.error(`[drafts] failed to initialize draft-list provider:`, err);
  });

  const onRequest = (event: RequestEvent) => {
    const { type } = event.detail;

    if (type === REQ_HOST_DOC) {
      provide<DocHandle<HasDrafts>>(event, hostDocHandle ?? ready);
      return;
    }

    if (type === REQ_HOST_REPO) {
      provide<Repo>(event, repo ?? ready.then(() => repo!));
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
    hostDocHandle = null;
  };

  function scheduleRewalk(): void {
    if (disposed) return;
    if (!repo || !hostDocHandle || !draftsStateHandle) return;
    if (rewalkInFlight) {
      rewalkPending = true;
      return;
    }
    rewalkInFlight = true;
    const liveRepo = repo;
    const liveHostDoc = hostDocHandle;
    const liveState = draftsStateHandle;
    void (async () => {
      try {
        const roots = (liveHostDoc.doc()?.["@patchwork"]?.drafts ?? []).filter(
          isValidAutomergeUrl
        );
        const allDrafts = await collectAllDrafts(
          liveRepo,
          roots,
          trackedDrafts,
          onTrackedChange
        );
        if (disposed) return;
        const current = liveState.doc()?.drafts ?? [];
        const selected = liveState.doc()?.selectedDraft ?? null;
        const nextSelected =
          selected && !allDrafts.includes(selected) ? null : selected;
        if (
          sameUrlList(current, allDrafts) &&
          nextSelected === selected
        ) {
          return;
        }
        liveState.change((d) => {
          d.drafts = allDrafts;
          d.selectedDraft = nextSelected;
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
  roots: readonly AutomergeUrl[],
  tracked: Map<AutomergeUrl, DocHandle<DraftDoc>>,
  onNewChange: () => void
): Promise<AutomergeUrl[]> {
  const visited = new Set<AutomergeUrl>();
  const order: AutomergeUrl[] = [];
  const queue: AutomergeUrl[] = [...roots];
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
      h.on("change", onNewChange);
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
