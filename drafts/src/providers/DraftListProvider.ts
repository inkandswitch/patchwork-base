import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
import type {
  MountedEvent,
  UnmountedEvent,
} from "@inkandswitch/patchwork-elements";

import type {
  DraftDoc,
  DraftMemberDoc,
  DraftsState,
  HasDrafts,
} from "../draft-types.js";
import { SKIPPED_DATATYPES, canonicalUrl } from "../clone-policy.js";

const ROOT_DOC_SELECTOR = "draft:root-doc";
const DRAFT_LIST_SELECTOR = "draft:list";
const MEMBER_DOCS_SELECTOR = "draft:member-docs";

const ATTR_DOC_URL = "doc-url";

// Mounts on a document URL and exposes that document's per-doc draft list:
//   - `draft:root-doc`    → AutomergeUrl of the doc this provider is on
//   - `draft:list`        → AutomergeUrl of the ephemeral DraftsState doc
//   - `draft:member-docs` → DraftMemberDoc[] for the documents in the current
//     view: on a draft, the forked docs from `DraftDoc.clones` (with their
//     clone url + fork point); on "main", the docs mounted beneath this
//     provider (observed via `patchwork:mounted`, fork fields `null`).
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

  // `draft:list` subscribers that arrived before the ephemeral
  // DraftsState doc was created; flushed once it exists.
  const pendingDraftsSubscribers = new Set<(url: AutomergeUrl) => void>();

  // `draft:member-docs` bookkeeping.
  const memberSubscribers = new Set<(members: DraftMemberDoc[]) => void>();
  let memberDocs: DraftMemberDoc[] = [];
  // Main-case membership: docs mounted beneath this provider, ref-counted so a
  // doc shown in several views is only dropped on its last unmount. Populated
  // even while a draft is selected (where it goes unused) so switching back to
  // main is instant.
  const mountCounts = new Map<AutomergeUrl, number>();
  // Cached "is this an app-global datatype we skip?" verdict per mounted url,
  // resolved lazily since reading `@patchwork.type` means loading the doc.
  // Absent = unresolved, treated as not-skipped (visible) until known.
  const skipVerdicts = new Map<AutomergeUrl, boolean>();

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  // A tracked draft changing can mean either its sub-draft list moved (needs a
  // rewalk) or its clone map grew (needs a member recompute), so do both.
  const onTrackedChange = () => {
    scheduleRewalk();
    recomputeMembers();
  };
  const onHostDocChange = () => scheduleRewalk();
  const onStateChange = () => recomputeMembers();

  const onMounted = (event: MountedEvent) => {
    const detail = event.detail;
    if (!("url" in detail)) return;
    const url = canonicalUrl(detail.url);
    mountCounts.set(url, (mountCounts.get(url) ?? 0) + 1);
    ensureSkipVerdict(url);
    recomputeMembers();
  };

  const onUnmounted = (event: UnmountedEvent) => {
    const detail = event.detail;
    if (!("url" in detail)) return;
    const url = canonicalUrl(detail.url);
    const count = mountCounts.get(url) ?? 0;
    if (count <= 1) mountCounts.delete(url);
    else mountCounts.set(url, count - 1);
    recomputeMembers();
  };

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
    for (const respond of pendingDraftsSubscribers) {
      respond(draftsUrl);
    }
    pendingDraftsSubscribers.clear();

    // Selection (`selectedDraft`) lives in this doc, so a change here is what
    // flips membership between a draft's clones and main's mounted docs.
    draftsStateHandle.on("change", onStateChange);
    handle.on("change", onHostDocChange);
    scheduleRewalk();
    recomputeMembers();
  })();
  ready.catch((err) => {
    console.error(`[drafts] failed to initialize draft-list provider:`, err);
  });

  const onSubscribe = (event: SubscribeEvent) => {
    const { type } = event.detail.selector;

    if (type === ROOT_DOC_SELECTOR) {
      accept<AutomergeUrl>(event, (respond) => {
        respond(docUrl);
      });
      return;
    }

    if (type === DRAFT_LIST_SELECTOR) {
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

    if (type === MEMBER_DOCS_SELECTOR) {
      accept<DraftMemberDoc[]>(event, (respond) => {
        respond(memberDocs);
        memberSubscribers.add(respond);
        return () => memberSubscribers.delete(respond);
      });
      return;
    }
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);
  element.addEventListener("patchwork:mounted", onMounted);
  element.addEventListener("patchwork:unmounted", onUnmounted);

  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    element.removeEventListener("patchwork:mounted", onMounted);
    element.removeEventListener("patchwork:unmounted", onUnmounted);
    if (hostDocHandle) hostDocHandle.off("change", onHostDocChange);
    if (draftsStateHandle) draftsStateHandle.off("change", onStateChange);
    for (const [, h] of trackedDrafts) h.off("change", onTrackedChange);
    trackedDrafts.clear();
    pendingDraftsSubscribers.clear();
    memberSubscribers.clear();
    mountCounts.clear();
    skipVerdicts.clear();
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
        // A rewalk may have just started tracking the selected draft (whose
        // clones won't fire their own change event), so refresh membership.
        recomputeMembers();
        if (rewalkPending) {
          rewalkPending = false;
          scheduleRewalk();
        }
      }
    })();
  }

  // Recompute the `draft:member-docs` set and push it to subscribers when it
  // actually changed.
  function recomputeMembers(): void {
    if (disposed) return;
    const next = computeMembers();
    if (memberListsEqual(memberDocs, next)) return;
    memberDocs = next;
    for (const respond of memberSubscribers) respond(next);
  }

  // On a draft, members come straight from that draft's clone map. On main
  // (no selection) they are the docs mounted beneath us, minus the app-global
  // datatypes the overlay would never fork. Both branches are sorted by url so
  // the equality check above is positional and stable.
  function computeMembers(): DraftMemberDoc[] {
    const selected = draftsStateHandle?.doc()?.selectedDraft ?? null;

    if (selected) {
      const clones = trackedDrafts.get(selected)?.doc()?.clones ?? {};
      return Object.entries(clones)
        .map(([url, entry]) => ({
          url: url as AutomergeUrl,
          cloneUrl: entry.cloneUrl,
          clonedAt: entry.clonedAt,
        }))
        .sort(byMemberUrl);
    }

    return [...mountCounts.keys()]
      .filter((url) => skipVerdicts.get(url) !== true)
      .map((url) => ({ url, cloneUrl: null, clonedAt: null }))
      .sort(byMemberUrl);
  }

  // Resolve (once, cached) whether a mounted doc is an app-global datatype we
  // exclude from the main-case membership. On failure we leave it unresolved,
  // so the doc stays visible — mirroring the overlay's "fall back to forking".
  function ensureSkipVerdict(url: AutomergeUrl): void {
    if (skipVerdicts.has(url)) return;
    void (async () => {
      try {
        const handle = await repo.find<HasDrafts>(url);
        if (disposed) return;
        const type = handle.doc()?.["@patchwork"]?.type;
        const skipped = type != null && SKIPPED_DATATYPES.has(type);
        if (skipVerdicts.get(url) === skipped) return;
        skipVerdicts.set(url, skipped);
        recomputeMembers();
      } catch {
        // Leave unresolved: the doc keeps showing up, which is the safe default.
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

function byMemberUrl(a: DraftMemberDoc, b: DraftMemberDoc): number {
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

function memberListsEqual(a: DraftMemberDoc[], b: DraftMemberDoc[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].url !== b[i].url) return false;
    if (a[i].cloneUrl !== b[i].cloneUrl) return false;
    if (!sameHeads(a[i].clonedAt, b[i].clonedAt)) return false;
  }
  return true;
}

function sameHeads(a: UrlHeads | null, b: UrlHeads | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((h) => set.has(h));
}
