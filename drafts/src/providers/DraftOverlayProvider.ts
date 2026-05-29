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

import { DraftRepo } from "../overlay/repo.js";
import type { DraftDoc } from "../draft-types.js";

// Mounts on a draft URL and owns the `DraftRepo` overlay for that draft;
// the frame keys remounts on `selectedDraft` so the overlay never has to
// be hot-swapped in place.
//
// If the `url` attribute is absent or empty the provider becomes a no-op:
// it registers no listeners and lets all `patchwork:request` events bubble
// up to the outer providers, so the frame can mount this component
// unconditionally and have "main" fall through to the host repo.
export const DraftOverlayProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute("url");
  if (!rawUrl) return () => {};
  if (!isValidAutomergeUrl(rawUrl)) {
    console.warn(
      `[drafts] <patchwork-view component="patchwork-draft-overlay-provider"> ` +
        `has an invalid url attribute (got ${JSON.stringify(rawUrl)})`
    );
    return () => {};
  }
  const draftUrl: AutomergeUrl = rawUrl;

  let draftRepo: DraftRepo | null = null;

  const readyPromise: Promise<DraftRepo> = (async () => {
    const repo = await request<Repo>(element, "patchwork:repo");
    if (!repo) {
      throw new Error(
        "[drafts] no `patchwork:repo` provider found; draft overlay provider disabled"
      );
    }
    const handle = await repo.find<DraftDoc>(draftUrl);
    draftRepo = new DraftRepo(repo, handle);
    return draftRepo;
  })();
  readyPromise.catch((err) => {
    console.error(
      `[drafts] failed to load draft overlay for ${draftUrl}:`,
      err
    );
  });

  const onRequest = (event: RequestEvent) => {
    const { type } = event.detail;

    if (type === "patchwork:repo") {
      provide<RepoLike>(event, draftRepo ?? readyPromise);
      return;
    }

    if (type === "patchwork:dochandle") {
      const url = event.detail.url as AutomergeUrl | undefined;
      const lookup = (dr: DraftRepo) =>
        url ? dr.find<unknown>(url) : dr.create<unknown>();
      provide<DocHandle<unknown>>(
        event,
        draftRepo ? lookup(draftRepo) : readyPromise.then(lookup)
      );
      return;
    }
  };

  element.addEventListener("patchwork:request", onRequest);
  return () => {
    element.removeEventListener("patchwork:request", onRequest);
  };
};
