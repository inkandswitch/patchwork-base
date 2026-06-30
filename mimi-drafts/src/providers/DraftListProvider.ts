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

// Console-logging helpers, so you can watch the draft machinery work. Every
// message is prefixed `[drafts:list]` (this provider, which tracks the draft
// tree and answers the list/baseline subscriptions). `short` trims long
// automerge urls down to a recognizable stub for readability.
const short = (url: string | null | undefined): string =>
  !url ? String(url) : url.replace(/^automerge:/, "").replace(/(.{6}).+(.{4})$/, "$1…$2");
const log = (msg: string, ...rest: unknown[]) =>
  console.log(`%c[drafts:list]%c ${msg}`, "color:#7c3aed;font-weight:bold", "", ...rest);

// How many times this provider has been instantiated in this page. Each instance
// mints its OWN ephemeral CheckedOutDraft (see `ready` below). If this climbs
// above 1, two instances exist — and whoever subscribed to draft:checked-out
// against the earlier one (e.g. the editor frame) is watching a DIFFERENT
// selection doc than the one the later instance answers with (e.g. the sidebar).
// That split is exactly how a draft selection can be written but never seen by
// the editor, so edits keep landing on main.
let instanceCount = 0;

// This is the piece that figures out what the drafts sidebar should show. It
// sits on a document and hands the sidebar three things:
//   - draft:root-doc    → which document we're on
//   - draft:checked-out → the small throwaway doc tracking what you have open
//                         (a draft, or "Main")
//   - draft:list        → the actual list to draw: a "Main" entry plus a card
//                         for each open draft, with the documents in each
//
// It works out the list by following the document's pointer to its "main draft"
// (the bookkeeping record), reading that record's list of drafts, and walking
// down into any sub-drafts. For the "Main" entry, before you've ever drafted the
// document, it instead watches which documents get used on screen.
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
  instanceCount += 1;
  const instanceId = instanceCount;
  log(
    `mounting on host doc ${short(docUrl)} — INSTANCE #${instanceId}` +
      (instanceId > 1
        ? ` ⚠️ MORE THAN ONE INSTANCE — each mints its own CheckedOutDraft, so ` +
          `subscribers split across instances will disagree on the selection ` +
          `(this is a likely cause of edits landing on main).`
        : ``) +
      ` — this provider tracks the draft tree and answers ` +
      `draft:root-doc / draft:checked-out / draft:list / draft:baseline`
  );

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
  // This document's one "main draft" — the bookkeeping record. Its list of
  // drafts is the starting point for everything, and it also backs the "Main"
  // entry. Loaded the first time we need it.
  let mainDraftHandle: DocHandle<DraftDoc> | null = null;

  // Anyone who asked "what's checked out?" before that doc existed yet; we
  // answer them as soon as it's created.
  const pendingCheckedOutSubscribers = new Set<(url: AutomergeUrl) => void>();

  // Who's waiting to be told "what version should I compare this document
  // against?" for each document, so we can re-answer them when things change.
  const baselineSubscribers = new Map<
    AutomergeUrl,
    Set<(baseline: Baseline) => void>
  >();

  // The current sidebar list, who wants to be notified when it changes, and the
  // order of drafts from the last time we walked the tree.
  const listSubscribers = new Set<(list: DraftList) => void>();
  let orderedDraftUrls: AutomergeUrl[] = [];
  let draftList: DraftList = {
    main: { url: docUrl, members: [], childCount: 0 },
    drafts: [],
  };
  // For the "Main" entry: which documents are currently on screen. Counted (not
  // just listed) so a doc shown in two places only disappears when the last one
  // goes away. Kept up to date even while you're in a draft, so switching back
  // to Main is instant.
  const mountCounts = new Map<AutomergeUrl, number>();
  // Remembers, per document, whether it's one of the app-wide docs we skip. We
  // have to load the doc to find out, so we cache the answer. Not-yet-known is
  // treated as "don't skip" (show it) until we learn otherwise.
  const skipVerdicts = new Map<AutomergeUrl, boolean>();

  let disposed = false;
  let rewalkInFlight = false;
  let rewalkPending = false;
  // When a draft we're watching changes, it could mean a few things — its list
  // of sub-drafts changed, or it just copied a new document — so we refresh
  // everything: re-walk the tree, rebuild the list, and re-answer the
  // "compare against what?" questions.
  const onTrackedChange = () => {
    scheduleRewalk();
    recomputeList();
    notifyBaselines();
  };
  const onHostDocChange = () => scheduleRewalk();
  // You changed what you're viewing (e.g. clicked into history), which changes
  // the comparison points, so re-answer everyone waiting on those.
  const onCheckedOutChange = () => {
    notifyBaselines();
  };

  // A document just appeared on screen: count it (for the "Main" entry) and
  // refresh.
  const onMounted = (event: MountedEvent) => {
    const detail = event.detail;
    if (!("url" in detail)) return;
    const url = canonicalUrl(detail.url);
    const next = (mountCounts.get(url) ?? 0) + 1;
    mountCounts.set(url, next);
    log(
      `doc mounted beneath us: ${short(url)} (refcount ${next}). ` +
        `Mounted docs become "main"'s membership until a real main draft exists.`
    );
    ensureSkipVerdict(url);
    syncMainDraftClones();
    recomputeList();
  };

  // A document left the screen: drop its count (removing it once nothing shows
  // it anymore) and refresh.
  const onUnmounted = (event: UnmountedEvent) => {
    const detail = event.detail;
    if (!("url" in detail)) return;
    const url = canonicalUrl(detail.url);
    const count = mountCounts.get(url) ?? 0;
    if (count <= 1) mountCounts.delete(url);
    else mountCounts.set(url, count - 1);
    log(`doc unmounted: ${short(url)} (refcount ${Math.max(0, count - 1)})`);
    recomputeList();
  };

  const ready: Promise<void> = (async () => {
    const handle = await repo.find<HasDrafts>(docUrl);
    if (disposed) return;
    hostDocHandle = handle;

    // Create the little "what's checked out" doc right away, so the sidebar can
    // show its "Main" card and let you switch around even before any drafts
    // exist.
    checkedOutHandle = repo.create<CheckedOutDraft>({ checkedOut: null });
    checkedOutHandle.on("change", onCheckedOutChange);
    const checkedOutUrl = checkedOutHandle.url;
    log(
      `[instance #${instanceId}] created ephemeral CheckedOutDraft ${short(checkedOutUrl)} ` +
        `(holds the selection; checkedOut=null means "main"). If you see more than ` +
        `one of these urls in the session, the sidebar and editor may be on different ones.`
    );
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
    log(`← subscription request for "${type}"`);

    if (type === ROOT_DOC_SELECTOR) {
      accept<AutomergeUrl>(event, (respond) => {
        log(`→ answering draft:root-doc with ${short(docUrl)}`);
        respond(docUrl);
      });
      return;
    }

    if (type === CHECKED_OUT_SELECTOR) {
      accept<AutomergeUrl>(event, (respond) => {
        if (checkedOutHandle) {
          log(
            `→ [instance #${instanceId}] answering draft:checked-out with ` +
              `${short(checkedOutHandle.url)} (whoever asked is now bound to THIS doc; ` +
              `if a different instance answers another subscriber, they won't agree)`
          );
          respond(checkedOutHandle.url);
          return;
        }
        log(`[instance #${instanceId}] draft:checked-out requested before the doc exists — queued`);
        pendingCheckedOutSubscribers.add(respond);
        return () => pendingCheckedOutSubscribers.delete(respond);
      });
      return;
    }

    if (type === DRAFT_LIST_SELECTOR) {
      // Note: this hands back the list itself (a plain object), not a document
      // url — so the sidebar must subscribe to the value directly rather than
      // try to load it as a document.
      accept<DraftList>(event, (respond) => {
        respond(draftList);
        listSubscribers.add(respond);
        return () => listSubscribers.delete(respond);
      });
      return;
    }

    if (type === BASELINE_SELECTOR) {
      // Answers "what version should I compare this document against to show what
      // the draft changed?" (see currentBaseline).
      const rawTarget = (event.detail.selector as { url?: unknown }).url;
      if (typeof rawTarget !== "string" || !isValidAutomergeUrl(rawTarget)) {
        return;
      }
      const target = canonicalUrl(rawTarget);
      accept<Baseline>(event, (respond) => {
        const baseline = currentBaseline(target);
        log(
          `→ answering draft:baseline for ${short(target)} — diff baseline ` +
            `heads: ${baseline.heads ? `${baseline.heads.length} head(s)` : "none"}`
        );
        respond(baseline);
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
        // All drafts hang off the main draft's list. That record only exists
        // once you've created your first draft; until then, there are none.
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
        log(
          `rewalked the draft tree: ${allDrafts.length} draft(s)` +
            (allDrafts.length ? ` → ${allDrafts.map(short).join(", ")}` : "")
        );

        // Reconcile the checkout pointer: if the checked-out draft is gone
        // (merged or detached), fall back to main.
        const selected = liveCheckedOut.doc()?.checkedOut ?? null;
        if (selected && !allDrafts.includes(selected)) {
          log(
            `checked-out draft ${short(selected)} no longer exists ` +
              `(merged or detached) — falling back to main`
          );
          liveCheckedOut.change((d) => {
            d.checkedOut = null;
          });
        }
      } catch (err) {
        console.error("[drafts] rewalk failed:", err);
      } finally {
        rewalkInFlight = false;
        // Walking the tree may have just picked up a new draft, so rebuild the
        // list to include it.
        recomputeList();
        if (rewalkPending) {
          rewalkPending = false;
          scheduleRewalk();
        }
      }
    })();
  }

  // Rebuild the sidebar list, and only tell the sidebar if it actually changed
  // (to avoid pointless re-renders).
  function recomputeList(): void {
    if (disposed) return;
    const next = computeList();
    if (draftListsEqual(draftList, next)) return;
    draftList = next;
    log(
      `draft:list changed → pushing to ${listSubscribers.size} subscriber(s). ` +
        `main: ${next.main.members.length} member doc(s); ${next.drafts.length} draft(s)`,
      next
    );
    for (const respond of listSubscribers) respond(next);
  }

  // Build the full list: the "Main" entry, plus one card for each open
  // (not-yet-merged) draft, in tree order.
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

  // Build the "Main" card. Its list of documents comes from the main draft's
  // record once that exists; before your first draft, we instead use whatever
  // documents are currently on screen, minus the app-wide ones we never copy.
  // (Sorted by url so comparing two lists for changes is straightforward.)
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

  // Work out what version to compare a document against, to highlight what
  // changed:
  //  - if you're viewing a history snapshot, use that snapshot's "from" version;
  //  - otherwise, in a draft, compare against where the draft's copy split off
  //    (so you see everything the draft has done);
  //  - otherwise (on Main, no snapshot), there's nothing to compare against.
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

  // Figure out (once, then remember) whether a document is one of the app-wide
  // ones we leave out of the "Main" list. If we can't tell, we leave it in —
  // the same safe default the copying code uses.
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

  // Find and start watching this document's main draft (its bookkeeping record),
  // if it has one yet. Returns null when you haven't drafted this document at
  // all. Watching it keeps the draft list and the "Main" entry up to date.
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
    log(
      `resolved this host doc's main draft: ${short(mainDraftUrl)} ` +
        `(bookkeeping doc whose .drafts roots the draft tree)`
    );
    syncMainDraftClones();
    return handle;
  }

  // Record, on the main draft, every document that's been on screen (except the
  // app-wide ones). On Main there's no real copy, so each entry just points the
  // document at itself. We only ever add, never remove, so the "Main" list and
  // its history stay stable even as documents come and go from the screen.
  function syncMainDraftClones(): void {
    if (disposed || !mainDraftHandle) return;
    const existing = mainDraftHandle.doc()?.clones ?? {};
    const toAdd = [...mountCounts.keys()].filter(
      (url) => skipVerdicts.get(url) === false && !existing[url]
    );
    if (toAdd.length === 0) return;
    log(
      `recording ${toAdd.length} identity clone(s) on the main draft ` +
        `(main "clones" point a doc at itself): ${toAdd.map(short).join(", ")}`
    );
    mainDraftHandle.change((d) => {
      for (const url of toAdd) {
        if (!d.clones[url]) {
          d.clones[url] = { cloneUrl: url, clonedAt: EMPTY_HEADS };
        }
      }
    });
  }
};

// Walk the whole draft tree, starting from the top-level drafts and following
// each one's sub-drafts, and return them all in order. Starts watching any
// draft it hasn't seen before, so later changes trigger a refresh.
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

// Turn a draft's record of copies into the list of documents the sidebar shows,
// sorted by url so two lists can be compared position-by-position.
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
