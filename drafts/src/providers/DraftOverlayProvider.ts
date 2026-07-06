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
  type DocHandleDescriptor,
  type SubscribeEvent,
} from "@inkandswitch/patchwork-providers";

import type { CheckedOutDraft, DraftDoc } from "../draft-types.js";
import { SKIPPED_DATATYPES, canonicalUrl } from "../clone-policy.js";

const HANDLE_DESCRIPTOR_SELECTOR = "repo:handle-descriptor";
const CHECKED_OUT_SELECTOR = "draft:checked-out";

// Remaps documents resolved beneath it onto per-draft clones, so edits stay
// inside the checked-out draft — and re-points *live* in place when the
// selection changes, without the host remounting anything.
//
// The host `<patchwork-view>` wraps tool document resolution in an
// `OverlayRepo` that opens a *streaming* `repo:handle-descriptor` subscription
// per document. This provider always claims those subscriptions (even while
// "main" is selected, where it answers a pass-through `{ url }`) and keeps the
// `respond` callbacks registered. It follows the selection itself via the
// ancestor draft-list provider's `draft:checked-out` doc: when
// `CheckedOutDraft.checkedOut` changes, every live subscription is re-answered
// with the new mapping — `{ url, cloneUrl }` on a draft (the clone is forked
// eagerly on first resolution and recorded in `DraftDoc.clones`), `{ url }` on
// main — and the `OverlayRepo` swaps handle backings in place.
//
// Descriptors also honor the active checkpoint: `CheckedOutDraft.at` maps each
// member doc to per-doc `to`/`from` heads, and the `to` heads are baked onto
// the backing url (the clone on a draft, the original on main) so nested views
// freeze with the doc they live in; `OverlayRepo` honors heads on the backing
// url. The fork point lives in `DraftDoc.clones[url].clonedAt`; the draft-list
// provider reads it to serve `draft:baseline` (this provider no longer answers
// that).
//
// A `url` attribute, when present, seeds the initial selection. That is how
// the chat preview iframe (see chat's `preview-frame.ts`) pins a
// self-bootstrapped overlay to a specific draft in a realm that has no
// draft-list provider to follow. The *current* selection is reflected onto the
// (un-observed, so remount-free) `draft-url` attribute for outside readers.
export const DraftOverlayProvider = (element: HTMLElement) => {
  const repo = "repo" in window ? window.repo : undefined;
  if (!repo) {
    console.warn(
      "[drafts] window.repo is not set; draft overlay provider disabled"
    );
    return () => {};
  }
  const liveRepo = repo;

  let disposed = false;

  // The checked-out draft this overlay currently maps onto. Null = "main"
  // (pass-through descriptors, save for checkpoint pinning).
  let draftUrl: AutomergeUrl | null = null;
  let draftReady: Promise<DocHandle<DraftDoc>> | null = null;
  // Bumped on every re-point so in-flight resolutions from a superseded
  // selection can detect they lost the race and stay silent.
  let switchEpoch = 0;

  // One eager-clone resolution per original url; de-dupes concurrent requests.
  // Cleared on re-point (it is per-draft state).
  const cloneResolutions = new Map<AutomergeUrl, Promise<AutomergeUrl>>();

  // Live `repo:handle-descriptor` subscriptions, kept so a re-point can push
  // fresh descriptors to every consumer.
  type DescriptorSubscriber = {
    original: AutomergeUrl;
    respond: (descriptor: DocHandleDescriptor) => void;
  };
  const descriptorSubscribers = new Set<DescriptorSubscriber>();

  // Seed the selection from the `url` attribute when present (the chat
  // preview iframe mounts us with a pinned draft and no draft-list provider).
  const rawSeed = element.getAttribute("url");
  if (rawSeed) {
    if (isValidAutomergeUrl(rawSeed)) {
      void applyDraft(rawSeed);
    } else {
      console.warn(
        `[drafts] <patchwork-view component="patchwork-draft-overlay-provider"> ` +
          `has an invalid url attribute (got ${JSON.stringify(rawSeed)})`
      );
    }
  }

  // Follow the selection: the ancestor draft-list provider serves the
  // ephemeral CheckedOutDraft doc url; we watch its `checkedOut` live. The
  // same doc carries the checkpoint (`at`), read at resolve time so
  // descriptors can pin a nested doc to its per-doc `to` heads — absent means
  // render live.
  let checkedOutHandle: DocHandle<CheckedOutDraft> | null = null;
  const onCheckedOutChange = () => {
    void applyDraft(checkedOutHandle?.doc()?.checkedOut ?? null);
  };
  const unsubscribeCheckedOut = subscribe<AutomergeUrl>(
    element,
    { type: CHECKED_OUT_SELECTOR },
    (url) => {
      if (disposed || !isValidAutomergeUrl(url)) return;
      void liveRepo.find<CheckedOutDraft>(url).then((handle) => {
        if (disposed || checkedOutHandle === handle) return;
        checkedOutHandle?.off("change", onCheckedOutChange);
        checkedOutHandle = handle;
        handle.on("change", onCheckedOutChange);
        onCheckedOutChange();
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
        const subscriber: DescriptorSubscriber = { original, respond };
        descriptorSubscribers.add(subscriber);
        const epoch = switchEpoch;
        void resolveDescriptor(original)
          .then((descriptor) => {
            // A re-point raced this resolution; `applyDraft`'s refresh pass
            // answers this subscriber with the new mapping instead.
            if (disposed || epoch !== switchEpoch) return;
            respond(descriptor);
          })
          .catch((err) => {
            console.error(`[drafts] failed to resolve ${original}:`, err);
          });
        return () => {
          descriptorSubscribers.delete(subscriber);
        };
      });
      return;
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    unsubscribeCheckedOut();
    checkedOutHandle?.off("change", onCheckedOutChange);
    checkedOutHandle = null;
    descriptorSubscribers.clear();
    cloneResolutions.clear();
  };

  // Re-point the overlay at a new selection in place: reset the per-draft
  // state, then push fresh descriptors to every live subscriber.
  async function applyDraft(next: AutomergeUrl | null): Promise<void> {
    if (disposed) return;
    if (next === draftUrl) return;

    draftUrl = next;
    const epoch = ++switchEpoch;
    cloneResolutions.clear();

    // Reflect the selection for outside readers (e.g. the chat preview frame).
    // `draft-url` is not observed by <patchwork-view>, so this never remounts.
    element.setAttribute("draft-url", next ?? "");

    draftReady = next
      ? (async () => {
          const handle = await liveRepo.find<DraftDoc>(next);
          if (disposed) {
            throw new Error("[drafts] provider disposed mid-load");
          }
          return handle;
        })()
      : null;
    draftReady?.catch((err) => {
      console.error(`[drafts] failed to load draft overlay for ${next}:`, err);
    });

    // Re-answer every live descriptor subscription against the new selection.
    // Each resolution is epoch-guarded so a rapid follow-up switch wins.
    for (const subscriber of [...descriptorSubscribers]) {
      void resolveDescriptor(subscriber.original)
        .then((descriptor) => {
          if (disposed || epoch !== switchEpoch) return;
          subscriber.respond(descriptor);
        })
        .catch((err) => {
          console.error(
            `[drafts] failed to re-map ${subscriber.original}:`,
            err
          );
        });
    }
  }

  // Resolve a `repo:handle-descriptor` request against the current selection.
  // The backing url is pinned to the active checkpoint's `to` heads for this
  // doc (if any) so nested views freeze with the doc they live in;
  // `OverlayRepo` honors heads on the backing url.
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

  // Ensure a clone of `original` exists for the current draft and return its
  // url. Reuses an existing clone recorded in `DraftDoc.clones`; otherwise
  // forks `original` at its current heads and records the fork point so the
  // baseline and merge-back can find it.
  function resolveClone(original: AutomergeUrl): Promise<AutomergeUrl> {
    const cached = cloneResolutions.get(original);
    if (cached) return cached;
    const ready = draftReady;
    const promise = (async () => {
      if (!ready) {
        throw new Error("[drafts] resolveClone called without a draft");
      }
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
