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
  WorkspaceDoc,
  WorkspaceState,
} from "../workspace-types.js";

const REQ_WORKSPACE = "patchwork:workspace";
const REQ_DRAFTS = "patchwork:drafts";

const ATTR_URL = "url";

type FolderShape = { workspaceUrl?: AutomergeUrl };

// Outer provider. Mounts on a folder URL, walks the draft tree from the
// folder's workspace doc, and exposes `patchwork:workspace` (root handle)
// and `patchwork:drafts` (ephemeral `WorkspaceState`). Repo-overlay routing
// lives in the inner `<patchwork-draft-provider>`.
export const WorkspaceProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute(ATTR_URL);
  if (!rawUrl || !isValidAutomergeUrl(rawUrl)) {
    console.warn(
      `[workspaces] <patchwork-view component="patchwork-workspace-provider"> ` +
        `is missing a valid ${ATTR_URL} attribute (got ${JSON.stringify(rawUrl)})`
    );
    return () => {};
  }
  const folderUrl: AutomergeUrl = rawUrl;

  let repo: Repo | null = null;
  let rootWorkspaceHandle: DocHandle<WorkspaceDoc> | null = null;
  let workspaceStateHandle: DocHandle<WorkspaceState> | null = null;
  const trackedHandles = new Map<AutomergeUrl, DocHandle<WorkspaceDoc>>();

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  const onTrackedChange = () => scheduleRewalk();

  const readyPromise: Promise<{
    root: DocHandle<WorkspaceDoc>;
    state: DocHandle<WorkspaceState>;
  }> = (async () => {
    const r = await request<Repo>(element, "patchwork:repo");
    if (!r) {
      throw new Error(
        "[workspaces] no `patchwork:repo` provider found; workspace provider disabled"
      );
    }
    repo = r;

    const folderHandle = await repo.find<FolderShape>(folderUrl);
    await folderHandle.whenReady();
    const wsUrl = folderHandle.doc()?.workspaceUrl;
    if (!wsUrl || !isValidAutomergeUrl(wsUrl)) {
      throw new Error(
        `[workspaces] folder ${folderUrl} has no valid workspaceUrl ` +
          `(got ${JSON.stringify(wsUrl)})`
      );
    }

    const root = await walkToRoot(repo, wsUrl, trackedHandles);
    rootWorkspaceHandle = root;
    const allDrafts = await collectAllDrafts(
      repo,
      root.url,
      trackedHandles
    );

    if (disposed) throw new Error("[workspaces] provider disposed mid-load");

    workspaceStateHandle = repo.create<WorkspaceState>({
      drafts: allDrafts,
      selectedDraft: root.url,
    });

    for (const [, h] of trackedHandles) h.on("change", onTrackedChange);

    return { root, state: workspaceStateHandle };
  })();
  readyPromise.catch((err) => {
    console.error(`[workspaces] failed to initialize workspace provider:`, err);
  });

  const onRequest = (event: RequestEvent) => {
    const { type } = event.detail;

    if (type === REQ_WORKSPACE) {
      provide<DocHandle<WorkspaceDoc>>(
        event,
        rootWorkspaceHandle ?? readyPromise.then(() => rootWorkspaceHandle)
      );
      return;
    }

    if (type === REQ_DRAFTS) {
      provide<DocHandle<WorkspaceState>>(
        event,
        workspaceStateHandle ?? readyPromise.then(() => workspaceStateHandle)
      );
      return;
    }
  };

  element.addEventListener("patchwork:request", onRequest);

  return () => {
    disposed = true;
    element.removeEventListener("patchwork:request", onRequest);
    for (const [, h] of trackedHandles) h.off("change", onTrackedChange);
    trackedHandles.clear();
    if (workspaceStateHandle && repo) {
      repo.delete(workspaceStateHandle.url);
    }
    workspaceStateHandle = null;
    rootWorkspaceHandle = null;
  };

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
        if (!rootWorkspaceHandle || !workspaceStateHandle) return;
        const allDrafts = await collectAllDrafts(
          liveRepo,
          rootWorkspaceHandle.url,
          trackedHandles,
          onTrackedChange
        );
        if (disposed || !workspaceStateHandle) return;
        const current = workspaceStateHandle.doc()?.drafts ?? [];
        if (sameUrlList(current, allDrafts)) return;
        workspaceStateHandle.change((d) => {
          d.drafts = allDrafts;
        });
      } catch (err) {
        console.error("[workspaces] rewalk failed:", err);
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

async function walkToRoot(
  repo: Repo,
  startUrl: AutomergeUrl,
  tracked: Map<AutomergeUrl, DocHandle<WorkspaceDoc>>
): Promise<DocHandle<WorkspaceDoc>> {
  let currentUrl: AutomergeUrl = startUrl;
  let lastHandle: DocHandle<WorkspaceDoc> | null = null;
  while (true) {
    const h = await repo.find<WorkspaceDoc>(currentUrl);
    await h.whenReady();
    tracked.set(currentUrl, h);
    lastHandle = h;
    const parent = h.doc()?.parent;
    if (!parent || !isValidAutomergeUrl(parent)) break;
    currentUrl = parent;
  }
  if (!lastHandle) throw new Error("[workspaces] walkToRoot found no handles");
  return lastHandle;
}

async function collectAllDrafts(
  repo: Repo,
  rootUrl: AutomergeUrl,
  tracked: Map<AutomergeUrl, DocHandle<WorkspaceDoc>>,
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
      h = await repo.find<WorkspaceDoc>(url);
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
