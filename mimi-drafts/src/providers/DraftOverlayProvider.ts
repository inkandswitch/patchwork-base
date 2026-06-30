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

// Console-logging helpers. Messages are prefixed `[drafts:overlay]` — this is
// the provider that intercepts every doc resolved beneath a draft and remaps it
// onto a per-draft clone, so edits stay scoped to the draft.
const short = (url: string | null | undefined): string =>
  !url ? String(url) : url.replace(/^automerge:/, "").replace(/(.{6}).+(.{4})$/, "$1…$2");
const log = (msg: string, ...rest: unknown[]) =>
  console.log(`%c[drafts:overlay]%c ${msg}`, "color:#0891b2;font-weight:bold", "", ...rest);

// This is the piece that makes a draft's edits stay private.
//
// It sits on a draft, and whenever the app asks for a document, this provider
// quietly swaps in the draft's private copy instead. The app keeps using the
// real document's url for display, but behind the scenes reads and writes go to
// the copy. The copy is made the first moment a document is actually used in the
// draft (and recorded in the draft, along with where it split off). The
// draft-list provider uses that split point to figure out diffs.
//
// On "Main" (no draft url) there's nothing to swap — you work on the real docs.
// But this provider still runs there for one reason: if you're viewing a history
// snapshot, it can pin each document to the right past version. That same pinning
// also happens inside a draft, applied to the copy. Which version to pin to is
// stored on the checked-out doc (CheckedOutDraft.at) and read here.
//
// (If it's handed an url that isn't valid, that's a setup mistake and the
// provider just does nothing.)
export const DraftOverlayProvider = (element: HTMLElement) => {
  const rawUrl = element.getAttribute("url");
  // No url = we're on "Main": don't swap in any copies, but still help pin
  // documents to a past version when viewing a history snapshot.
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

  log(
    draftUrl
      ? `mounting on draft ${short(draftUrl)} — docs resolved here get forked into per-draft clones`
      : `mounting on "main" (no url) — no cloning, but checkpoints can still pin nested docs`
  );

  const repo = "repo" in window ? window.repo : undefined;
  if (!repo) {
    console.warn(
      "[drafts] window.repo is not set; draft overlay provider disabled"
    );
    return () => {};
  }
  const liveRepo = repo;

  let disposed = false;

  // Remembers the in-progress "make a copy of this doc" work, one per document,
  // so two requests at once don't accidentally make two copies.
  const cloneResolutions = new Map<AutomergeUrl, Promise<AutomergeUrl>>();

  // The draft this provider is working on (where the copies are recorded).
  // Null when we're on "Main".
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

  // Keeps an eye on which history snapshot (if any) is being viewed, so we can
  // show each document at the right past version. If there's no snapshot for a
  // document, we just show it live.
  let checkedOutHandle: DocHandle<CheckedOutDraft> | null = null;
  const unsubscribeCheckedOut = subscribe<AutomergeUrl>(
    element,
    { type: CHECKED_OUT_SELECTOR },
    (url) => {
      if (disposed || !isValidAutomergeUrl(url)) return;
      void liveRepo.find<CheckedOutDraft>(url).then((handle) => {
        if (disposed) return;
        checkedOutHandle = handle;
        // Watch the selection so we can SEE, on this specific overlay instance,
        // whether a draft got selected while this overlay is still mounted on
        // "main" (or on a different draft). That mismatch is the classic reason
        // edits keep landing on main: the selected draft changed, but the
        // element's `url` attribute (which fixed `draftUrl` at mount) didn't,
        // so this overlay never starts forking.
        const logSelection = () => {
          const selected = handle.doc()?.checkedOut ?? null;
          const mismatch = (selected ?? null) !== (draftUrl ?? null);
          log(
            `checked-out selection is now ${selected ? `draft ${short(selected)}` : "main"}; ` +
              `this overlay is mounted on ${draftUrl ? `draft ${short(draftUrl)}` : "main"}` +
              (mismatch
                ? ` — ⚠️ MISMATCH: edits will route to "${draftUrl ? "this draft" : "main"}", ` +
                  `not the selected one. (Is the overlay element's url attribute updated on select?)`
                : " — ✓ match")
          );
        };
        logSelection();
        handle.on("change", logSelection);
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
      log(`← handle-descriptor requested for ${short(original)}`);
      accept<DocHandleDescriptor>(event, (respond) => {
        void resolveDescriptor(original).then((descriptor) => {
          if (disposed) return;
          log(
            `→ descriptor for ${short(original)}: reported url=${short(descriptor.url)}, ` +
              `backing=${short(descriptor.cloneUrl ?? descriptor.url)}` +
              `${descriptor.cloneUrl ? " (clone)" : ""}`
          );
          respond(descriptor);
        });
      });
      return;
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  return () => {
    log(
      `unmounting overlay that was on ${draftUrl ? `draft ${short(draftUrl)}` : "main"}. ` +
        `(If selecting a draft does NOT log a fresh "mounting on draft …" right after this, ` +
        `the editor's overlay element isn't being re-created for the selected draft.)`
    );
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    unsubscribeCheckedOut();
    cloneResolutions.clear();
  };

  // The core decision: when the app asks for a document, what do we actually
  // give it back? In every case the app still sees the real document's url; what
  // changes is which underlying copy/version it reads and writes:
  //  - On "Main": the real document (frozen to a past version if viewing history).
  //  - For skipped docs (account, contacts): always the real document, never a copy.
  //  - Otherwise, inside a draft: the draft's private copy (also frozen to a past
  //    version when viewing history).
  async function resolveDescriptor(
    original: AutomergeUrl
  ): Promise<DocHandleDescriptor> {
    const selected = checkedOutHandle?.doc()?.checkedOut ?? null;
    log(
      `resolving descriptor for ${short(original)}: this overlay's draftUrl=` +
        `${draftUrl ? short(draftUrl) : "null (main)"}, checked-out selection=` +
        `${selected ? short(selected) : "null (main)"}` +
        ((selected ?? null) !== (draftUrl ?? null)
          ? ` — ⚠️ overlay does NOT match selection; routing will follow draftUrl (${draftUrl ? "fork" : "MAIN"})`
          : "")
    );
    const to = checkedOutHandle?.doc()?.at?.[original]?.to ?? undefined;
    if (to) {
      log(`${short(original)} is pinned by an active checkpoint (frozen, read-only view)`);
    }
    if (!draftUrl) {
      log(`on "main": returning ${short(original)} unforked → edits to ${short(original)} hit MAIN`);
      return to
        ? { url: original, cloneUrl: withHeads(original, to) }
        : { url: original };
    }
    if (await isSkippedDoc(original)) {
      log(
        `${short(original)} is an app-global datatype (account/contact/draft) — ` +
          `never forked, using the real doc`
      );
      return to
        ? { url: original, cloneUrl: withHeads(original, to) }
        : { url: original };
    }
    const cloneUrl = await resolveClone(original);
    return { url: original, cloneUrl: withHeads(cloneUrl, to) };
  }

  // Tag a document's url with a specific past version, so the app loads it as it
  // was at that moment. If there's no version to pin to, return the url as-is.
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

  // Is this one of the app-wide documents we must never copy (see
  // SKIPPED_DATATYPES)? If we can't tell for some reason, we assume "no" and let
  // it be copied — the safe default, since the worst case is an extra copy
  // rather than losing data.
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

  // Get this draft's private copy of a document, making one if it doesn't exist
  // yet. If we've already copied it, reuse that copy. Otherwise copy the document
  // as it stands right now and remember where it split off, so diffs and merging
  // back can work later.
  function resolveClone(original: AutomergeUrl): Promise<AutomergeUrl> {
    const cached = cloneResolutions.get(original);
    if (cached) return cached;
    const promise = (async () => {
      if (!ready) throw new Error("[drafts] resolveClone called without a draft");
      const handle = await ready;
      const existing = handle.doc()?.clones?.[original];
      if (existing) {
        log(
          `reusing existing clone for ${short(original)} → ${short(existing.cloneUrl)}`
        );
        return canonicalUrl(existing.cloneUrl);
      }

      const originalHandle = await liveRepo.find<unknown>(original);
      const clonedAt = originalHandle.heads();
      const clone = liveRepo.clone(originalHandle);
      const cloneUrl = canonicalUrl(clone.url);
      log(
        `FORK: cloned ${short(original)} → ${short(cloneUrl)} at fork point ` +
          `${clonedAt?.length ?? 0} head(s). Draft edits now land on the clone.`
      );

      handle.change((d) => {
        d.clones[original] = { cloneUrl, clonedAt };
      });

      return cloneUrl;
    })();
    cloneResolutions.set(original, promise);
    return promise;
  }
};
