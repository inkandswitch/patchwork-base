import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import {
  accept,
  type DocHandleDescriptor,
  type SubscribeEvent,
} from "@inkandswitch/patchwork-providers";

import type { Baseline, DraftDoc } from "../draft-types.js";

const DOCHANDLE_SELECTOR = "patchwork:dochandle";
const BASELINE_SELECTOR = "patchwork:baseline";

// Mounts on a draft URL and remaps documents resolved beneath it onto
// per-draft clones, so edits stay inside the draft.
//
// Under the new provider model the host `<patchwork-view>` wraps legacy tool
// document resolution in an `OverlayRepo` that asks the provider tree for a
// `patchwork:dochandle` descriptor. This provider answers with
// `{ url, cloneUrl }`: the clone is forked eagerly the first time a document is
// requested in this draft (recorded in `DraftDoc.clones`), and the editor then
// reads and writes the clone while still reporting the original url. The fork
// point is published as `patchwork:baseline { heads }` so consumers can render
// a diff against the pre-draft state.
//
// If the `url` attribute is absent or empty the provider becomes a no-op: it
// registers no listeners and lets `patchwork:dochandle`/`patchwork:baseline`
// subscriptions bubble up to the root `<repo-provider>`, so the frame can mount
// this component unconditionally and have "main" fall through to the host repo.
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

  const repo = "repo" in window ? window.repo : undefined;
  if (!repo) {
    console.warn(
      "[drafts] window.repo is not set; draft overlay provider disabled"
    );
    return () => {};
  }
  const liveRepo = repo;

  let draftHandle: DocHandle<DraftDoc> | null = null;
  let disposed = false;

  // One eager-clone resolution per original url; de-dupes concurrent requests.
  const cloneResolutions = new Map<AutomergeUrl, Promise<AutomergeUrl>>();
  // `patchwork:baseline` subscribers keyed by the canonical target url.
  const baselineSubscribers = new Map<
    AutomergeUrl,
    Set<(baseline: Baseline) => void>
  >();

  const ready: Promise<DocHandle<DraftDoc>> = (async () => {
    const handle = await liveRepo.find<DraftDoc>(draftUrl);
    await handle.whenReady();
    if (disposed) throw new Error("[drafts] provider disposed mid-load");
    draftHandle = handle;
    return handle;
  })();
  ready.catch((err) => {
    console.error(
      `[drafts] failed to load draft overlay for ${draftUrl}:`,
      err
    );
  });

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector;

    if (selector.type === DOCHANDLE_SELECTOR) {
      const rawTarget = selector.url;
      if (typeof rawTarget !== "string" || !isValidAutomergeUrl(rawTarget)) {
        return;
      }
      const original = canonicalUrl(rawTarget);
      accept<DocHandleDescriptor>(event, (respond) => {
        void resolveClone(original).then((cloneUrl) => {
          if (disposed) return;
          respond({ url: original, cloneUrl });
        });
      });
      return;
    }

    if (selector.type === BASELINE_SELECTOR) {
      const rawTarget = selector.url;
      if (typeof rawTarget !== "string" || !isValidAutomergeUrl(rawTarget)) {
        return;
      }
      const target = canonicalUrl(rawTarget);
      accept<Baseline>(event, (respond) => {
        void ready.then(() => {
          if (disposed) return;
          respond(currentBaseline(target));
        });
        let set = baselineSubscribers.get(target);
        if (!set) baselineSubscribers.set(target, (set = new Set()));
        set.add(respond);
        return () => {
          set!.delete(respond);
          if (set!.size === 0) baselineSubscribers.delete(target);
        };
      });
      return;
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    baselineSubscribers.clear();
    cloneResolutions.clear();
  };

  // Ensure a clone of `original` exists for this draft and return its url.
  // Reuses an existing clone recorded in `DraftDoc.clones`; otherwise forks
  // `original` at its current heads and records the fork point so the baseline
  // and merge-back can find it.
  function resolveClone(original: AutomergeUrl): Promise<AutomergeUrl> {
    const cached = cloneResolutions.get(original);
    if (cached) return cached;
    const promise = (async () => {
      const handle = await ready;
      const existing = handle.doc()?.clones?.[original];
      if (existing) return canonicalUrl(existing.cloneUrl);

      const originalHandle = await liveRepo.find<unknown>(original);
      await originalHandle.whenReady();
      const clonedAt = originalHandle.heads();
      const clone = liveRepo.clone(originalHandle);
      const cloneUrl = canonicalUrl(clone.url);

      handle.change((d) => {
        d.clones[original] = { cloneUrl, clonedAt };
      });

      notifyBaseline(original);
      return cloneUrl;
    })();
    cloneResolutions.set(original, promise);
    return promise;
  }

  function currentBaseline(target: AutomergeUrl): Baseline {
    const heads = draftHandle?.doc()?.clones?.[target]?.clonedAt;
    return { heads: heads ?? null };
  }

  function notifyBaseline(target: AutomergeUrl): void {
    const set = baselineSubscribers.get(target);
    if (!set) return;
    const baseline = currentBaseline(target);
    for (const respond of [...set]) respond(baseline);
  }
};

function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}
