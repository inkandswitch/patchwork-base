import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import {
  provide,
  request,
  type RepoLike,
  type RequestEvent,
} from "@inkandswitch/patchwork-providers";

import { WorkspaceRepo } from "../overlay/repo.js";
import type { WorkspaceDoc } from "../workspace-types.js";

// Inner provider. Mounts on a draft URL and owns the `WorkspaceRepo`
// overlay for that draft; the frame keys remounts on `selectedDraft` so the
// overlay never has to be hot-swapped in place.
export const DraftProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute("url");
  if (!rawUrl || !isValidAutomergeUrl(rawUrl)) {
    console.warn(
      `[workspaces] <patchwork-view component="patchwork-draft-provider"> ` +
        `is missing a valid url attribute (got ${JSON.stringify(rawUrl)})`
    );
    return () => {};
  }
  const draftUrl: AutomergeUrl = rawUrl;

  let workspaceRepo: WorkspaceRepo | null = null;

  const readyPromise: Promise<WorkspaceRepo> = (async () => {
    const repo = await request<Repo>(element, "patchwork:repo");
    if (!repo) {
      throw new Error(
        "[workspaces] no `patchwork:repo` provider found; draft provider disabled"
      );
    }
    const handle = await repo.find<WorkspaceDoc>(draftUrl);
    workspaceRepo = new WorkspaceRepo(repo, handle);
    return workspaceRepo;
  })();
  readyPromise.catch((err) => {
    console.error(`[workspaces] failed to load draft ${draftUrl}:`, err);
  });

  const onRequest = (event: RequestEvent) => {
    const { type } = event.detail;

    if (type === "patchwork:repo") {
      provide<RepoLike>(event, workspaceRepo ?? readyPromise);
      return;
    }

    if (type === "patchwork:dochandle") {
      const url = event.detail.url as AutomergeUrl | undefined;
      const lookup = (ws: WorkspaceRepo) =>
        url ? ws.find<unknown>(url) : ws.create<unknown>();
      provide<DocHandle<unknown>>(
        event,
        workspaceRepo ? lookup(workspaceRepo) : readyPromise.then(lookup)
      );
      return;
    }
  };

  element.addEventListener("patchwork:request", onRequest);
  return () => {
    element.removeEventListener("patchwork:request", onRequest);
  };
};
