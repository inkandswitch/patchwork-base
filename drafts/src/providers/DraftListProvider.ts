import {
  encodeHeads,
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
  Baseline,
  CheckedOutDraft,
  CloneEntry,
  DraftDoc,
  DraftList,
  DraftMemberDoc,
  DraftSummary,
  HasDrafts,
} from "../draft-types.js";
import { SKIPPED_DATATYPES, canonicalUrl } from "../clone-policy.js";

const ROOT_DOC_SELECTOR = "draft:root-doc";
const CHECKED_OUT_SELECTOR = "draft:checked-out";
const DRAFT_LIST_SELECTOR = "draft:list";
const BASELINE_SELECTOR = "draft:baseline";

const ATTR_DOC_URL = "doc-url";

// Fork point recorded for the main draft's identity clones: empty heads means
// "from the start", so `getChangesMetaSince(doc, [])` yields the full history.
const EMPTY_HEADS: UrlHeads = encodeHeads([]);

// Mounts on a document URL and exposes that document's draft state via three
// subscriptions:
//   - `draft:root-doc`    → AutomergeUrl of the doc this provider is on
//   - `draft:checked-out` → AutomergeUrl of the ephemeral, writeable
//     CheckedOutDraft doc; holds only the selection (`checkedOut = null` = main)
//   - `draft:list`        → DraftList: the read-only main entry plus one
//     `DraftSummary` per non-merged draft, each carrying its member docs (on a
//     draft, the forked docs from `DraftDoc.clones`; on main, the main draft's
//     identity clones, or — before the first draft — the docs mounted beneath
//     this provider observed via `patchwork:mounted`, fork fields `null`).
//
// Consumers recover the live `DocHandle`s from the realm-local `window.repo`,
// so member entries carry only plain `AutomergeUrl`s. The link from a host doc
// to its drafts is `@patchwork.mainDraftUrl` → the main draft, whose `drafts`
// roots the tree; each `DraftDoc` may have its own sub-drafts via
// `DraftDoc.drafts`.
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
  let checkedOutHandle: DocHandle<CheckedOutDraft> | null = null;
  const trackedDrafts = new Map<AutomergeUrl, DocHandle<DraftDoc>>();
  // The host doc's single main draft (bookkeeping only). Resolved lazily from
  // `@patchwork.mainDraftUrl`; its `drafts` roots the draft tree and its
  // identity `clones` back the "main" member list.
  let mainDraftHandle: DocHandle<DraftDoc> | null = null;

  // `draft:checked-out` subscribers that arrived before the ephemeral
  // CheckedOutDraft doc was created; flushed once it exists.
  const pendingCheckedOutSubscribers = new Set<(url: AutomergeUrl) => void>();

  // `draft:baseline` subscribers, keyed by canonical target url. This provider
  // is the sole answerer (the overlay no longer claims it), serving the
  // checkpoint's per-doc `from` when pinned and the checked-out draft's
  // fork point otherwise (see `currentBaseline`). Re-emitted whenever the
  // checkout doc or a tracked draft's clones change.
  const baselineSubscribers = new Map<
    AutomergeUrl,
    Set<(baseline: Baseline) => void>
  >();

  // `draft:list` bookkeeping: the last computed list, its live subscribers, and
  // the draft order from the most recent rewalk.
  const listSubscribers = new Set<(list: DraftList) => void>();
  let orderedDraftUrls: AutomergeUrl[] = [];
  let draftList: DraftList = {
    main: { url: docUrl, members: [], childCount: 0 },
    drafts: [],
  };
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
  // rewalk) or its clone map grew (needs a list recompute), so do both. A new
  // clone also gives a checked-out draft a fork-point baseline, so re-publish.
  const onTrackedChange = () => {
    scheduleRewalk();
    recomputeList();
    notifyBaselines();
  };
  const onHostDocChange = () => scheduleRewalk();
  // The checkout doc changed: its `at` checkpoint may have been set, cleared, or
  // moved, so re-publish every live `draft:baseline` subscriber.
  const onCheckedOutChange = () => notifyBaselines();

  const onMounted = (event: MountedEvent) => {
    const detail = event.detail;
    if (!("url" in detail)) return;
    const url = canonicalUrl(detail.url);
    mountCounts.set(url, (mountCounts.get(url) ?? 0) + 1);
    ensureSkipVerdict(url);
    syncMainDraftClones();
    recomputeList();
  };

  const onUnmounted = (event: UnmountedEvent) => {
    const detail = event.detail;
    if (!("url" in detail)) return;
    const url = canonicalUrl(detail.url);
    const count = mountCounts.get(url) ?? 0;
    if (count <= 1) mountCounts.delete(url);
    else mountCounts.set(url, count - 1);
    recomputeList();
  };

  const ready: Promise<void> = (async () => {
    const handle = await repo.find<HasDrafts>(docUrl);
    if (disposed) return;
    hostDocHandle = handle;

    // Eagerly create the ephemeral CheckedOutDraft so the sidebar can render
    // its "Main" card and write `checkedOut` even before any drafts exist on
    // the host doc.
    checkedOutHandle = repo.create<CheckedOutDraft>({ checkedOut: null });
    checkedOutHandle.on("change", onCheckedOutChange);
    const checkedOutUrl = checkedOutHandle.url;
    for (const respond of pendingCheckedOutSubscribers) {
      respond(checkedOutUrl);
    }
    pendingCheckedOutSubscribers.clear();
    // A checkpoint may already have synced in before this provider mounted.
    notifyBaselines();

    handle.on("change", onHostDocChange);
    scheduleRewalk();
    recomputeList();
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

    if (type === CHECKED_OUT_SELECTOR) {
      accept<AutomergeUrl>(event, (respond) => {
        if (checkedOutHandle) {
          respond(checkedOutHandle.url);
          return;
        }
        pendingCheckedOutSubscribers.add(respond);
        return () => pendingCheckedOutSubscribers.delete(respond);
      });
      return;
    }

    if (type === DRAFT_LIST_SELECTOR) {
      // `draft:list` answers with a DraftList *object*, never an AutomergeUrl, so
      // consumers must use `subscribe` (not `subscribeDoc`, which would feed this
      // object into `repo.find` and crash with "Invalid AutomergeUrl").
      accept<DraftList>(event, (respond) => {
        respond(draftList);
        listSubscribers.add(respond);
        return () => listSubscribers.delete(respond);
      });
      return;
    }

    if (type === BASELINE_SELECTOR) {
      // Sole answerer for `draft:baseline` (the overlay no longer claims it):
      // serves the pinned checkpoint's `from` or the checked-out draft's fork
      // point for `target` (see `currentBaseline`).
      const rawTarget = (event.detail.selector as { url?: unknown }).url;
      if (typeof rawTarget !== "string" || !isValidAutomergeUrl(rawTarget)) {
        return;
      }
      const target = canonicalUrl(rawTarget);
      accept<Baseline>(event, (respond) => {
        respond(currentBaseline(target));
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
  element.addEventListener("patchwork:mounted", onMounted);
  element.addEventListener("patchwork:unmounted", onUnmounted);

  return () => {
    disposed = true;
    element.removeEventListener("patchwork:subscribe", onSubscribe);
    element.removeEventListener("patchwork:mounted", onMounted);
    element.removeEventListener("patchwork:unmounted", onUnmounted);
    if (hostDocHandle) hostDocHandle.off("change", onHostDocChange);
    if (mainDraftHandle) mainDraftHandle.off("change", onTrackedChange);
    for (const [, h] of trackedDrafts) h.off("change", onTrackedChange);
    mainDraftHandle = null;
    trackedDrafts.clear();
    pendingCheckedOutSubscribers.clear();
    listSubscribers.clear();
    baselineSubscribers.clear();
    mountCounts.clear();
    skipVerdicts.clear();
    if (checkedOutHandle) {
      checkedOutHandle.off("change", onCheckedOutChange);
      repo.delete(checkedOutHandle.url);
    }
    checkedOutHandle = null;
    hostDocHandle = null;
  };

  function scheduleRewalk(): void {
    if (disposed) return;
    if (!hostDocHandle || !checkedOutHandle) return;
    if (rewalkInFlight) {
      rewalkPending = true;
      return;
    }
    rewalkInFlight = true;
    const liveCheckedOut = checkedOutHandle;
    void (async () => {
      try {
        // Drafts hang off the main draft (`mainDraft.drafts`), which is created
        // on the first draft; until then there are none.
        const mainDraft = await ensureMainDraftTracked();
        if (disposed) return;
        const roots = (mainDraft?.doc()?.drafts ?? []).filter(
          isValidAutomergeUrl
        );
        const allDrafts = await collectAllDrafts(
          repo,
          roots,
          trackedDrafts,
          onTrackedChange
        );
        if (disposed) return;
        orderedDraftUrls = allDrafts;

        // Reconcile the checkout pointer: if the checked-out draft is gone
        // (merged or detached), fall back to main.
        const selected = liveCheckedOut.doc()?.checkedOut ?? null;
        if (selected && !allDrafts.includes(selected)) {
          liveCheckedOut.change((d) => {
            d.checkedOut = null;
          });
        }
      } catch (err) {
        console.error("[drafts] rewalk failed:", err);
      } finally {
        rewalkInFlight = false;
        // A rewalk may have just started tracking a draft (whose clones won't
        // fire their own change event), so refresh the list.
        recomputeList();
        if (rewalkPending) {
          rewalkPending = false;
          scheduleRewalk();
        }
      }
    })();
  }

  // Recompute the `draft:list` value and push it to subscribers when it
  // actually changed.
  function recomputeList(): void {
    if (disposed) return;
    const next = computeList();
    if (draftListsEqual(draftList, next)) return;
    draftList = next;
    for (const respond of listSubscribers) respond(next);
  }

  // The full read-only list: the main entry plus one summary per non-merged
  // draft, in rewalk (tree) order.
  function computeList(): DraftList {
    const drafts: DraftSummary[] = [];
    for (const url of orderedDraftUrls) {
      const doc = trackedDrafts.get(url)?.doc();
      if (!doc || doc.mergedAt !== undefined) continue;
      drafts.push({
        url,
        members: clonesToMembers(doc.clones),
        childCount: doc.drafts.length,
      });
    }
    return { main: computeMainSummary(), drafts };
  }

  // Main's summary. Its members come from the main draft's identity clones once
  // it exists; before the first draft is created (no main draft) we fall back to
  // the docs mounted beneath us, minus the app-global datatypes the overlay
  // would never fork. Members are sorted by url so the diff above is positional.
  function computeMainSummary(): DraftSummary {
    const url = mainDraftHandle?.url ?? docUrl;
    const childCount = mainDraftHandle?.doc()?.drafts.length ?? 0;

    const mainClones = mainDraftHandle?.doc()?.clones;
    if (mainClones && Object.keys(mainClones).length > 0) {
      return { url, members: clonesToMembers(mainClones), childCount };
    }

    const members = [...mountCounts.keys()]
      .filter((u) => skipVerdicts.get(u) !== true)
      .map((u) => ({ url: u, cloneUrl: null, clonedAt: null }))
      .sort(byMemberUrl);
    return { url, members, childCount };
  }

  // The diff baseline for `target`, authoritative for both main and drafts:
  //  - a pinned checkpoint honors that doc's `from` exactly (`null` = no diff);
  //  - otherwise, on a draft, the doc diffs against its clone's fork point;
  //  - otherwise (main, no pin) there is no baseline.
  function currentBaseline(target: AutomergeUrl): Baseline {
    const doc = checkedOutHandle?.doc();
    const entry = doc?.at?.[target];
    if (entry) return { heads: entry.from ?? null };

    const checkedOut = doc?.checkedOut;
    if (checkedOut) {
      const clonedAt = trackedDrafts.get(checkedOut)?.doc()?.clones?.[target]
        ?.clonedAt;
      return { heads: clonedAt ?? null };
    }
    return { heads: null };
  }

  function notifyBaselines(): void {
    for (const [target, set] of baselineSubscribers) {
      const baseline = currentBaseline(target);
      for (const respond of [...set]) respond(baseline);
    }
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
        // A now-confirmed not-skipped doc may belong in the main draft.
        syncMainDraftClones();
        recomputeList();
      } catch {
        // Leave unresolved: the doc keeps showing up, which is the safe default.
      }
    })();
  }

  // Resolve and start tracking the host doc's main draft, if any. Returns the
  // handle, or null when the host doc has no `mainDraftUrl` yet. Re-resolves
  // when the pointer changes and attaches `onTrackedChange` so the main draft's
  // `drafts` (tree shape) and `clones` (main membership) stay live.
  async function ensureMainDraftTracked(): Promise<DocHandle<DraftDoc> | null> {
    if (!hostDocHandle) return null;
    const mainDraftUrl = hostDocHandle.doc()?.["@patchwork"]?.mainDraftUrl;
    if (!mainDraftUrl || !isValidAutomergeUrl(mainDraftUrl)) return null;
    if (mainDraftHandle && mainDraftHandle.url === mainDraftUrl) {
      return mainDraftHandle;
    }
    if (mainDraftHandle) mainDraftHandle.off("change", onTrackedChange);
    const handle = await repo.find<DraftDoc>(mainDraftUrl);
    if (disposed) return null;
    mainDraftHandle = handle;
    handle.on("change", onTrackedChange);
    syncMainDraftClones();
    return handle;
  }

  // Keep the main draft's identity clone map in step with the live mounted set:
  // every confirmed not-skipped mounted doc gets an identity entry (`cloneUrl
  // === url`, empty fork heads). Additive only — entries are never removed, so
  // main's membership (and history) is stable across unmounts. Writes are
  // diffed, so this is a no-op once everything mounted is already recorded.
  function syncMainDraftClones(): void {
    if (disposed || !mainDraftHandle) return;
    const existing = mainDraftHandle.doc()?.clones ?? {};
    const toAdd = [...mountCounts.keys()].filter(
      (url) => skipVerdicts.get(url) === false && !existing[url]
    );
    if (toAdd.length === 0) return;
    mainDraftHandle.change((d) => {
      for (const url of toAdd) {
        if (!d.clones[url]) {
          d.clones[url] = { cloneUrl: url, clonedAt: EMPTY_HEADS };
        }
      }
    });
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

// Project a clone map into member-doc entries, sorted by url so the positional
// equality checks below stay valid.
function clonesToMembers(
  clones: Record<AutomergeUrl, CloneEntry>
): DraftMemberDoc[] {
  return Object.entries(clones)
    .map(([url, entry]) => ({
      url: url as AutomergeUrl,
      cloneUrl: entry.cloneUrl,
      clonedAt: entry.clonedAt,
    }))
    .sort(byMemberUrl);
}

function draftListsEqual(a: DraftList, b: DraftList): boolean {
  if (!summariesEqual(a.main, b.main)) return false;
  if (a.drafts.length !== b.drafts.length) return false;
  for (let i = 0; i < a.drafts.length; i++) {
    if (!summariesEqual(a.drafts[i], b.drafts[i])) return false;
  }
  return true;
}

function summariesEqual(a: DraftSummary, b: DraftSummary): boolean {
  return (
    a.url === b.url &&
    a.childCount === b.childCount &&
    memberListsEqual(a.members, b.members)
  );
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
