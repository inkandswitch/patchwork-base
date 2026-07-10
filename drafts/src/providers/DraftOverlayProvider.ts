import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type UrlHeads,
} from "@automerge/automerge-repo";
import {
  accept,
  subscribe,
  type SubscribeEvent,
} from "@inkandswitch/patchwork-providers";

// Shape of a `repo:handle-descriptor` answer. The one-shot host's
// patchwork-providers (0.2.2) does not export this type, so it is declared
// locally; it must stay in sync with the host's `OverlayRepo`.
type DocHandleDescriptor = {
  url: AutomergeUrl;
  cloneUrl?: AutomergeUrl;
};

import type { CheckedOutDraft, DraftDoc } from "../draft-types.js";
import { SKIPPED_DATATYPES, canonicalUrl } from "../clone-policy.js";

const HANDLE_DESCRIPTOR_SELECTOR = "repo:handle-descriptor";
const CHECKED_OUT_SELECTOR = "draft:checked-out";

// Mounts on a draft URL and remaps documents resolved beneath it onto
// per-draft clones, so edits stay inside the draft.
//
// Under the new provider model the host `<patchwork-view>` wraps legacy tool
// document resolution in an `OverlayRepo` that asks the provider tree for a
// `repo:handle-descriptor` descriptor. This provider answers with
// `{ url, cloneUrl }`: the clone is forked eagerly the first time a document is
// requested in this draft (recorded in `DraftDoc.clones`), and the editor then
// reads and writes the clone while still reporting the original url. The fork
// point lives in `DraftDoc.clones[url].clonedAt`; the draft-list provider reads
// it to serve `draft:baseline` (this provider no longer answers that).
//
// On "main" (empty `url`) there is no clone remapping, but the provider still
// answers `repo:handle-descriptor` so that an active checkpoint can pin nested
// docs: it returns the original url carrying the checkpoint's `to` heads when one
// is set. Pinning also applies on a draft, baked onto the clone url. The per-doc
// `to`/`from` heads live on the checked-out draft (`CheckedOutDraft.at`), read
// here via the `draft:checked-out` subscription. A non-empty but invalid `url`
// is a misconfiguration and disables the provider.
export const DraftOverlayProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute("url");
  // Empty `url` = "main": no clone remapping, but we still answer
  // `repo:handle-descriptor` so an active checkpoint can pin nested docs.
  let draftUrl: AutomergeUrl | null = null;
  if (rawUrl) {
    if (!isValidAutomergeUrl(rawUrl)) {
      console.warn(
        `[drafts] <patchwork-view component="patchwork-draft-overlay-provider"> ` +
          `has an invalid url attribute (got ${JSON.stringify(rawUrl)})`
      );
      return () => {};
    }
    draftUrl = rawUrl;
  }

  const repo = "repo" in window ? window.repo : undefined;
  if (!repo) {
    console.warn(
      "[drafts] window.repo is not set; draft overlay provider disabled"
    );
    return () => {};
  }
  const liveRepo = repo;

  let disposed = false;

  // One eager-clone resolution per original url; de-dupes concurrent requests.
  const cloneResolutions = new Map<AutomergeUrl, Promise<AutomergeUrl>>();

  // The draft doc backing this overlay (clone bookkeeping). Null on "main".
  const ready: Promise<DocHandle<DraftDoc>> | null = draftUrl
    ? (async () => {
        const handle = await liveRepo.find<DraftDoc>(draftUrl);
        if (disposed) throw new Error("[drafts] provider disposed mid-load");
        return handle;
      })()
    : null;
  ready?.catch((err) => {
    console.error(`[drafts] failed to load draft overlay for ${draftUrl}:`, err);
  });

  // Track the checked-out draft's checkpoint so descriptors can pin a nested doc
  // to its per-doc `to` heads. The url is served by the ancestor draft-list
  // provider; we read `at[original].to` live at resolve time (one-shot, so we
  // never block on this — absent means render live).
  let checkedOutHandle: DocHandle<CheckedOutDraft> | null = null;
  const unsubscribeCheckedOut = subscribe<AutomergeUrl>(
    element,
    { type: CHECKED_OUT_SELECTOR },
    (url) => {
      if (disposed || !isValidAutomergeUrl(url)) return;
      void liveRepo.find<CheckedOutDraft>(url).then((handle) => {
        if (!disposed) checkedOutHandle = handle;
      });
    }
  );

  const onSubscribe = (event: SubscribeEvent) => {
    const selector = event.detail.selector;

    if (selector.type === HANDLE_DESCRIPTOR_SELECTOR) {
      const rawTarget = selector.url;
      if (typeof rawTarget !== "string" || !isValidAutomergeUrl(rawTarget)) {
        return;
      }
      const original = canonicalUrl(rawTarget);
      accept<DocHandleDescriptor>(event, (respond) => {
        void resolveDescriptor(original).then((descriptor) => {
          if (disposed) return;
          respond(descriptor);
        });
      });
      return;
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    unsubscribeCheckedOut();
    cloneResolutions.clear();
  };

  // Resolve a `repo:handle-descriptor` request. The backing url is pinned to the
  // active checkpoint's `to` heads for this doc (if any) so nested views freeze
  // with the doc they live in; `OverlayRepo` honors heads on the backing url.
  //  - On "main" (no draft): no clone, just the (maybe pinned) original.
  //  - Skipped docs (account, contacts): the real doc, never forked.
  //  - Everything else on a draft: the per-draft clone (pinned when checked out).
  async function resolveDescriptor(
    original: AutomergeUrl
  ): Promise<DocHandleDescriptor> {
    const to = checkedOutHandle?.doc()?.at?.[original]?.to ?? undefined;
    if (!draftUrl || (await isSkippedDoc(original))) {
      return to
        ? { url: original, cloneUrl: withHeads(original, to) }
        : { url: original };
    }
    const cloneUrl = await resolveClone(original);
    return { url: original, cloneUrl: withHeads(cloneUrl, to) };
  }

  // Stamp `heads` onto `url` (same documentId), or return it unchanged when
  // there is no pin. Heads ride on the url so `OverlayRepo` resolves the doc at
  // that point in time.
  function withHeads(
    url: AutomergeUrl,
    heads: UrlHeads | undefined
  ): AutomergeUrl {
    if (!heads) return url;
    return stringifyAutomergeUrl({
      documentId: parseAutomergeUrl(url).documentId,
      heads,
    });
  }

  // A doc is skipped when its `@patchwork.type` is in `SKIPPED_DATATYPES`. On
  // any failure we fall back to cloning (the existing behaviour), which is the
  // safe default — a doc that should be skipped merely keeps forking, it isn't
  // lost.
  async function isSkippedDoc(original: AutomergeUrl): Promise<boolean> {
    try {
      const handle = await liveRepo.find<{ "@patchwork"?: { type?: string } }>(
        original
      );
      const type = handle.doc()?.["@patchwork"]?.type;
      return type != null && SKIPPED_DATATYPES.has(type);
    } catch {
      return false;
    }
  }

  // Ensure a clone of `original` exists for this draft and return its url.
  // Reuses an existing clone recorded in `DraftDoc.clones`; otherwise forks
  // `original` at its current heads and records the fork point so the baseline
  // and merge-back can find it.
  function resolveClone(original: AutomergeUrl): Promise<AutomergeUrl> {
    const cached = cloneResolutions.get(original);
    if (cached) return cached;
    const promise = (async () => {
      if (!ready) throw new Error("[drafts] resolveClone called without a draft");
      const handle = await ready;
      const existing = handle.doc()?.clones?.[original];
      if (existing) return canonicalUrl(existing.cloneUrl);

      const originalHandle = await liveRepo.find<unknown>(original);
      const clonedAt = originalHandle.heads();
      const clone = liveRepo.clone(originalHandle);
      const cloneUrl = canonicalUrl(clone.url);

      handle.change((d) => {
        d.clones[original] = { cloneUrl, clonedAt };
      });

      return cloneUrl;
    })();
    cloneResolutions.set(original, promise);
    return promise;
  }
};
