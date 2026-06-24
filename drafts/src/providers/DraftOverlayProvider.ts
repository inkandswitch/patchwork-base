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

const HANDLE_DESCRIPTOR_SELECTOR = "repo:handle-descriptor";
const BASELINE_SELECTOR = "draft:baseline";

// HACK: datatypes the draft overlay must never clone into a draft.
//
// The overlay forks *every* document resolved beneath it so edits stay scoped
// to the draft. But some docs pulled through the overlay are app-global rather
// than part of the document being drafted: the account doc (read by the context
// sidebar, which renders inside the overlay) and contact docs (resolved per
// comment author). Forking those branches global state — account config, user
// profiles — into a draft, which is wrong and could even merge back into main.
//
// The principled fix is to know which documents actually belong to the draft
// and fork only those — the overlay shouldn't clone a doc just because it was
// resolved beneath it. Until we have that notion of draft membership we invert
// the problem with a blunt skip-list: it bakes app-level datatype names into
// the otherwise-generic overlay and relies on each doc carrying a matching
// `@patchwork.type`.
const SKIPPED_DATATYPES: ReadonlySet<string> = new Set([
  "account",
  "contact",
  "draft",
]);

// Mounts on a draft URL and remaps documents resolved beneath it onto
// per-draft clones, so edits stay inside the draft.
//
// Under the new provider model the host `<patchwork-view>` wraps legacy tool
// document resolution in an `OverlayRepo` that asks the provider tree for a
// `repo:handle-descriptor` descriptor. This provider answers with
// `{ url, cloneUrl }`: the clone is forked eagerly the first time a document is
// requested in this draft (recorded in `DraftDoc.clones`), and the editor then
// reads and writes the clone while still reporting the original url. The fork
// point is published as `draft:baseline { heads }` so consumers can render
// a diff against the pre-draft state.
//
// If the `url` attribute is absent or empty the provider becomes a no-op: it
// registers no listeners and lets `repo:handle-descriptor`/`draft:baseline`
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
  // `draft:baseline` subscribers keyed by the canonical target url.
  const baselineSubscribers = new Map<
    AutomergeUrl,
    Set<(baseline: Baseline) => void>
  >();

  const ready: Promise<DocHandle<DraftDoc>> = (async () => {
    const handle = await liveRepo.find<DraftDoc>(draftUrl);
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

  // Resolve a `repo:handle-descriptor` request: skipped docs (account, contacts)
  // resolve straight to the real doc (no `cloneUrl` -> no fork); everything
  // else is forked into this draft via `resolveClone`.
  async function resolveDescriptor(
    original: AutomergeUrl
  ): Promise<DocHandleDescriptor> {
    if (await isSkippedDoc(original)) return { url: original };
    const cloneUrl = await resolveClone(original);
    return { url: original, cloneUrl };
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
