import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";

import type { DraftDoc, DraftsState, HasDrafts } from "../draft-types.js";

const HOST_DOC_SELECTOR = "patchwork:host-doc";
const DRAFTS_SELECTOR = "patchwork:drafts";

const ATTR_DOC_URL = "doc-url";

// Mounts on a document URL and exposes that document's per-doc draft list:
//   - `patchwork:host-doc` → AutomergeUrl of the doc this provider is on
//   - `patchwork:drafts`   → AutomergeUrl of the ephemeral DraftsState doc
//
// Consumers recover the live `DocHandle`s from the realm-local `window.repo`,
// so only plain `AutomergeUrl`s cross the subscription channel.
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

  const maybeRepo = "repo" in window ? window.repo : undefined;
  if (!maybeRepo) {
    console.warn(
      "[drafts] window.repo is not set; draft-list provider disabled"
    );
    return () => {};
  }
  const repo: Repo = maybeRepo;

  let hostDocHandle: DocHandle<HasDrafts> | null = null;
  let draftsStateHandle: DocHandle<DraftsState> | null = null;
  const trackedDrafts = new Map<AutomergeUrl, DocHandle<DraftDoc>>();

  // `patchwork:drafts` subscribers that arrived before the ephemeral
  // DraftsState doc was created; flushed once it exists.
  const pendingDraftsSubscribers = new Set<(url: AutomergeUrl) => void>();

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  const onTrackedChange = () => scheduleRewalk();
  const onHostDocChange = () => scheduleRewalk();

  const ready: Promise<void> = (async () => {
    const handle = await repo.find<HasDrafts>(docUrl);
    if (disposed) return;
    hostDocHandle = handle;

    // Eagerly create the ephemeral DraftsState so the sidebar can render
    // its "Main" card and write `selectedDraft` even before any drafts
    // exist on the host doc.
    draftsStateHandle = repo.create<DraftsState>({
      drafts: [],
      selectedDraft: null,
    });
    const draftsUrl = draftsStateHandle.url;
    for (const respond of pendingDraftsSubscribers) respond(draftsUrl);
    pendingDraftsSubscribers.clear();

    handle.on("change", onHostDocChange);
    scheduleRewalk();
  })();
  ready.catch((err) => {
    console.error(`[drafts] failed to initialize draft-list provider:`, err);
  });

  const onSubscribe = (event: SubscribeEvent) => {
    const { type } = event.detail.selector;

    if (type === HOST_DOC_SELECTOR) {
      accept<AutomergeUrl>(event, (respond) => {
        respond(docUrl);
      });
      return;
    }

    if (type === DRAFTS_SELECTOR) {
      accept<AutomergeUrl>(event, (respond) => {
        if (draftsStateHandle) {
          respond(draftsStateHandle.url);
          return;
        }
        pendingDraftsSubscribers.add(respond);
        return () => pendingDraftsSubscribers.delete(respond);
      });
      return;
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    if (hostDocHandle) hostDocHandle.off("change", onHostDocChange);
    for (const [, h] of trackedDrafts) h.off("change", onTrackedChange);
    trackedDrafts.clear();
    pendingDraftsSubscribers.clear();
    if (draftsStateHandle) repo.delete(draftsStateHandle.url);
    draftsStateHandle = null;
    hostDocHandle = null;
  };

  function scheduleRewalk(): void {
    if (disposed) return;
    if (!hostDocHandle || !draftsStateHandle) return;
    if (rewalkInFlight) {
      rewalkPending = true;
      return;
    }
    rewalkInFlight = true;
    const liveHostDoc = hostDocHandle;
    const liveState = draftsStateHandle;
    void (async () => {
      try {
        const roots = (liveHostDoc.doc()?.["@patchwork"]?.drafts ?? []).filter(
          isValidAutomergeUrl
        );
        const allDrafts = await collectAllDrafts(
          repo,
          roots,
          trackedDrafts,
          onTrackedChange
        );
        if (disposed) return;
        const current = liveState.doc()?.drafts ?? [];
        const selected = liveState.doc()?.selectedDraft ?? null;
        const nextSelected =
          selected && !allDrafts.includes(selected) ? null : selected;
        if (sameUrlList(current, allDrafts) && nextSelected === selected) {
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
