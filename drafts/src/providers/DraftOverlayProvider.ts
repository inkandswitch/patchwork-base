import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
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
import type { Baseline, DraftDoc } from "../draft-types.js";

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
  const baselineHandles = new Map<AutomergeUrl, DocHandle<Baseline>>();
  let disposed = false;
  let rescanScheduled = false;

  const readyPromise: Promise<DraftRepo> = (async () => {
    const repo = await request<Repo>(element, "patchwork:repo");
    if (!repo) {
      throw new Error(
        "[drafts] no `patchwork:repo` provider found; draft overlay provider disabled"
      );
    }
    const handle = await repo.find<DraftDoc>(draftUrl);
    draftRepo = new DraftRepo(repo, handle);
    handle.on("change", scheduleRescan);
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

    if (type === "patchwork:baseline") {
      const rawTarget = event.detail.url;
      if (typeof rawTarget !== "string" || !isValidAutomergeUrl(rawTarget)) {
        console.log(
          "[drafts/baseline] ignoring request, invalid target url:",
          rawTarget
        );
        return;
      }
      const target = canonicalUrl(rawTarget);
      console.log(
        "[drafts/baseline] request for",
        target,
        "draft:",
        draftUrl,
        "draftRepo ready:",
        !!draftRepo
      );
      provide<DocHandle<Baseline>>(
        event,
        draftRepo
          ? baselineFor(draftRepo, target)
          : readyPromise.then((dr) => baselineFor(dr, target))
      );
      return;
    }
  };

  element.addEventListener("patchwork:request", onRequest);
  return () => {
    disposed = true;
    element.removeEventListener("patchwork:request", onRequest);
    if (draftRepo) draftRepo.draftHandle.off("change", scheduleRescan);
    for (const [, h] of baselineHandles) {
      draftRepo?.repo.delete(h.url);
    }
    baselineHandles.clear();
  };

  // Defer to a microtask so we never write to a baseline doc synchronously
  // from inside a `draftHandle.change` callback. The COW path records the
  // clone via `draftHandle.change` while still inside CodeMirror's
  // `view.update`, and a synchronous baseline write here would propagate
  // through Solid into `view.dispatch` → reentrancy error.
  function scheduleRescan(): void {
    if (rescanScheduled) return;
    rescanScheduled = true;
    queueMicrotask(() => {
      rescanScheduled = false;
      onDraftChange();
    });
  }

  // Returns the cached baseline handle for `target`, creating it if needed
  // and seeding `heads` from the current `clonedAt` (if any).
  function baselineFor(
    dr: DraftRepo,
    target: AutomergeUrl
  ): DocHandle<Baseline> {
    const cached = baselineHandles.get(target);
    if (cached) {
      console.log(
        "[drafts/baseline] reusing cached baseline for",
        target,
        "heads:",
        cached.doc()?.heads
      );
      return cached;
    }
    const initial = dr.draftHandle.doc()?.clones?.[target]?.clonedAt;
    const handle = dr.repo.create<Baseline>(
      initial ? { heads: initial } : {}
    );
    baselineHandles.set(target, handle);
    console.log(
      "[drafts/baseline] created baseline for",
      target,
      "initial heads:",
      initial,
      "baseline url:",
      handle.url
    );
    return handle;
  }

  // Sync every cached baseline to the current `clonedAt`. Cheap: there are
  // typically only a handful of baseline subscribers per draft, and writes
  // are no-ops when the heads haven't changed.
  function onDraftChange(): void {
    if (disposed || !draftRepo) return;
    const clones = draftRepo.draftHandle.doc()?.clones ?? {};
    console.log(
      "[drafts/baseline] draft changed, clones now:",
      Object.keys(clones),
      "watching:",
      Array.from(baselineHandles.keys())
    );
    for (const [target, baseline] of baselineHandles) {
      const next = clones[target]?.clonedAt;
      const current = baseline.doc()?.heads;
      if (sameHeads(current, next)) continue;
      console.log(
        "[drafts/baseline] updating baseline for",
        target,
        "from",
        current,
        "to",
        next
      );
      baseline.change((d) => {
        if (next) d.heads = next;
        else delete d.heads;
      });
    }
  }
};

function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}

function sameHeads(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
