import {
  decodeHeads,
  encodeHeads,
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo";
import * as Automerge from "@automerge/automerge";

import type {
  CachedGroup,
  ChangeGroupCacheDoc,
  DraftDoc,
  DraftMemberDoc,
  HasDrafts,
} from "./draft-types.js";

// Bump to discard every existing cache doc's contents (they self-rebuild).
export const CHANGE_GROUP_CACHE_VERSION = 1;

// A pause between consecutive changes longer than this starts a new group:
// bursts of continuous editing read as a single row, however long they run,
// and any minute-plus lull splits the timeline. Baked into the cache doc —
// changing it invalidates and rebuilds every cache.
export const INACTIVITY_GAP_MS = 60 * 1000;

// How long a fill may hold the main thread before yielding to idle time.
const SLICE_BUDGET_MS = 8;

// Coalesce bursts of member-doc change events into one incremental fill.
const FILL_DEBOUNCE_MS = 250;

// One timeline the filler is responsible for: the DraftDoc that owns it
// (main included — the main draft is always real), the member docs whose
// interleaved changes make it up, and the host doc whose creation time is
// the "before this document existed" cutoff.
export type TimelineSpec = {
  draftHandle: DocHandle<DraftDoc>;
  members: DraftMemberDoc[];
  rootDocUrl: AutomergeUrl;
};

export type ChangeGroupCacheFiller = {
  // Reconcile the set of timelines to keep filled (ordered by priority:
  // earlier specs fill first). Attaches member-doc change listeners that
  // drive incremental fills; timelines absent from the list are torn down.
  sync: (specs: TimelineSpec[]) => void;
  dispose: () => void;
};

// Resolve the host doc's single main draft, creating it (and pointing
// `@patchwork.mainDraftUrl` at it) the first time. The main draft is
// bookkeeping only: the list provider seeds its identity `clones`, and its
// `drafts` holds the top-level draft list. Check-then-create — the rare
// concurrent-create orphan is accepted, same as always.
export async function ensureMainDraft(
  repo: Repo,
  docHandle: DocHandle<HasDrafts>
): Promise<DocHandle<DraftDoc>> {
  const existingUrl = docHandle.doc()?.["@patchwork"]?.mainDraftUrl;
  if (existingUrl) return repo.find<DraftDoc>(existingUrl);

  const mainDraft = repo.create<DraftDoc>({
    "@patchwork": { type: "draft" },
    isMain: true,
    parent: docHandle.url,
    drafts: [],
    clones: {},
  });
  docHandle.change((d) => {
    // Mutate `@patchwork` in place. Spreading it into a fresh object and
    // reassigning would carry over references to existing document objects,
    // which Automerge rejects ("Cannot create a reference to an existing
    // document object").
    if (!d["@patchwork"]) d["@patchwork"] = {};
    d["@patchwork"]!.mainDraftUrl = mainDraft.url;
  });
  return mainDraft;
}

// Resolve a draft's change-group cache doc, creating it and stamping
// `changeGroupCacheUrl` the first time. A cache whose format version or
// grouping parameter no longer matches is emptied in place (same url) and
// left to rebuild.
export async function ensureChangeGroupCache(
  repo: Repo,
  draftHandle: DocHandle<DraftDoc>
): Promise<DocHandle<ChangeGroupCacheDoc>> {
  const existingUrl = draftHandle.doc()?.changeGroupCacheUrl;
  if (existingUrl && isValidAutomergeUrl(existingUrl)) {
    const handle = await repo.find<ChangeGroupCacheDoc>(existingUrl);
    const doc = handle.doc();
    if (
      doc &&
      (doc.version !== CHANGE_GROUP_CACHE_VERSION ||
        doc.inactivityGapMs !== INACTIVITY_GAP_MS)
    ) {
      handle.change((d) => {
        d.version = CHANGE_GROUP_CACHE_VERSION;
        d.inactivityGapMs = INACTIVITY_GAP_MS;
        d.groups = {};
        d.computedThrough = {};
      });
    }
    return handle;
  }

  const cache = repo.create<ChangeGroupCacheDoc>({
    "@patchwork": { type: "change-group-cache" },
    version: CHANGE_GROUP_CACHE_VERSION,
    inactivityGapMs: INACTIVITY_GAP_MS,
    groups: {},
    computedThrough: {},
  });
  draftHandle.change((d) => {
    if (!d.changeGroupCacheUrl) d.changeGroupCacheUrl = cache.url;
  });
  // A concurrent creator may have won the stamp; honor whichever pointer
  // settled (our fresh doc is then an accepted orphan, same as mainDraftUrl).
  const settled = draftHandle.doc()?.changeGroupCacheUrl;
  if (settled && settled !== cache.url && isValidAutomergeUrl(settled)) {
    return repo.find<ChangeGroupCacheDoc>(settled);
  }
  return cache;
}

// Work out one change's rough edit magnitude by diffing it against its parents
// and counting its patches: splice lengths and insert counts as additions, del
// lengths as deletions, everything else (put / inc / mark / …) as one addition.
// `@patchwork` metadata paths are ignored. A pure function of immutable
// history, so each change is diffed once, here, and only the group aggregates
// are kept.
export function computeEditCounts(
  doc: Automerge.Doc<unknown>,
  hash: string,
  deps: string[]
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  try {
    const patches = Automerge.diff(
      doc,
      deps as unknown as Automerge.Heads,
      [hash] as unknown as Automerge.Heads
    );
    for (const patch of patches) {
      if (patch.path[0] === "@patchwork") continue;
      if (patch.action === "splice") {
        additions += (patch.value as string).length;
      } else if (patch.action === "insert") {
        additions += Array.isArray((patch as { values?: unknown[] }).values)
          ? (patch as { values: unknown[] }).values.length
          : 1;
      } else if (patch.action === "del") {
        deletions += (patch as { length?: number }).length ?? 1;
      } else {
        additions += 1;
      }
    }
  } catch (err) {
    console.warn("[drafts] failed to diff change for edit counts:", hash, err);
  }
  return { additions, deletions };
}

// When was a document created, as a Unix SECONDS timestamp? Reads the doc's
// full history and returns its first change's time (the creation change).
// Returns undefined when the doc, its history, or that time can't be resolved,
// in which case callers skip the "before creation" filter rather than hiding
// everything.
export async function getDocCreationTime(
  repo: Repo,
  url: AutomergeUrl | undefined
): Promise<number | undefined> {
  if (!url) return undefined;
  try {
    const handle = await repo.find<unknown>(url);
    const doc = handle.doc();
    if (!doc) return undefined;
    const metas = Automerge.getChangesMetaSince(doc, []);
    return metas[0]?.time || undefined;
  } catch (err) {
    console.warn("[drafts] failed to resolve creation time for:", url, err);
    return undefined;
  }
}

// One member change awaiting aggregation. `seq` is the change's index within
// its member's gathered metas, used only to break same-second timestamp ties
// (meta.time is second-resolution) with the doc's own causal order.
type PendingChange = {
  memberUrl: AutomergeUrl;
  doc: Automerge.Doc<unknown>;
  hash: string;
  deps: string[];
  time: number;
  actor: string;
  seq: number;
};

// Newest first by timestamp, per-doc causal order breaking same-second ties.
// The sidebar's on-demand scrub resolution MUST order identically, or the
// scrubber's index math drifts from `changeCount`.
function newestFirst(a: PendingChange, b: PendingChange): number {
  return b.time - a.time || b.seq - a.seq;
}

// Fold a flat, newest-first list of changes into groups: consecutive changes
// stay together while the pause between them is at most the inactivity gap.
function splitIntoGroups(
  rowsNewestFirst: PendingChange[]
): PendingChange[][] {
  const groups: PendingChange[][] = [];
  let window: PendingChange[] = [];
  let prevTimeMs: number | null = null;
  for (const row of rowsNewestFirst) {
    const timeMs = row.time * 1000;
    // Rows arrive newest-first, so the previous row is this change's newer
    // neighbour; a gap larger than the threshold between them is a lull.
    if (
      prevTimeMs !== null &&
      prevTimeMs - timeMs > INACTIVITY_GAP_MS &&
      window.length > 0
    ) {
      groups.push(window);
      window = [];
    }
    window.push(row);
    prevTimeMs = timeMs;
  }
  if (window.length > 0) groups.push(window);
  return groups;
}

function groupId(rowsNewestFirst: PendingChange[]): string {
  return `tg-${rowsNewestFirst[0].hash}`;
}

// Append `member`'s changes since `since` onto `out`, dropping anything from
// before the root document was created (a member dragged in after the fact
// would otherwise contribute pre-existing history that reads as noise). `seq`
// still reflects each change's position in the gathered metas, so filtering
// doesn't disturb the tie-break ordering.
function collectMemberRows(
  out: PendingChange[],
  member: DraftMemberDoc,
  doc: Automerge.Doc<unknown>,
  since: Automerge.Heads,
  createdAt: number | undefined
): void {
  let metas;
  try {
    metas = Automerge.getChangesMetaSince(doc, since);
  } catch (err) {
    console.warn(
      "[drafts] change-group cache: failed to read changes for member:",
      member.url,
      err
    );
    return;
  }
  metas.forEach((meta, seq) => {
    if (createdAt !== undefined && meta.time && meta.time < createdAt) return;
    out.push({
      memberUrl: member.url,
      doc,
      hash: meta.hash,
      deps: meta.deps,
      time: meta.time,
      actor: meta.actor,
      seq,
    });
  });
}

function dedupedActors(rowsNewestFirst: PendingChange[]): string[] {
  const actors: string[] = [];
  for (const row of rowsNewestFirst) {
    if (!actors.includes(row.actor)) actors.push(row.actor);
  }
  return actors;
}

// Yield to the main thread between diff slices.
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// Time-budgeted cooperative slicing: `tick()` resolves immediately while the
// current slice has budget left, otherwise runs `onYield` (flush pending
// writes) and waits for idle time. Resolves false once the run is aborted.
type Slicer = { tick: () => Promise<boolean> };

function createSlicer(isAborted: () => boolean, onYield: () => void): Slicer {
  let sliceStart = performance.now();
  return {
    async tick(): Promise<boolean> {
      if (isAborted()) return false;
      if (performance.now() - sliceStart < SLICE_BUDGET_MS) return true;
      onYield();
      await idle();
      sliceStart = performance.now();
      return !isAborted();
    },
  };
}

// Diff every change in a group (newest-first, sliced) and aggregate the
// result down to the CachedGroup a timeline row renders. Returns null when
// the run was aborted mid-diff.
async function buildGroup(
  rowsNewestFirst: PendingChange[],
  slicer: Slicer
): Promise<CachedGroup | null> {
  let additions = 0;
  let deletions = 0;
  for (const row of rowsNewestFirst) {
    if (!(await slicer.tick())) return null;
    const counts = computeEditCounts(row.doc, row.hash, row.deps);
    additions += counts.additions;
    deletions += counts.deletions;
  }
  const newest = rowsNewestFirst[0];
  const oldest = rowsNewestFirst[rowsNewestFirst.length - 1];
  return {
    id: groupId(rowsNewestFirst),
    startTime: oldest.time,
    endTime: newest.time,
    newestMemberUrl: newest.memberUrl,
    newestHash: newest.hash,
    actors: dedupedActors(rowsNewestFirst),
    additions,
    deletions,
    changeCount: rowsNewestFirst.length,
  };
}

function byMemberUrl(a: DraftMemberDoc, b: DraftMemberDoc): number {
  return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
}

function sameHeads(a: UrlHeads | undefined, b: UrlHeads | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((h) => set.has(h));
}

// The write side of the grouping cache: owns one background task per
// timeline, listens to member docs for edits, and fills each timeline's
// ChangeGroupCacheDoc in idle-time slices — newest groups first, older
// history backfilling behind them. One global runner processes timelines
// sequentially in the priority order `sync` was given.
export function createChangeGroupCacheFiller(
  repo: Repo
): ChangeGroupCacheFiller {
  // Change listeners on the docs a timeline reads (originals for main,
  // clones for drafts). `handle` is null while the doc is still resolving —
  // the slot is reserved up front so concurrent syncs don't double-attach.
  type SourceListener = {
    handle: DocHandle<unknown> | null;
    onChange: () => void;
  };

  type Task = {
    key: AutomergeUrl; // the DraftDoc url
    spec: TimelineSpec;
    listeners: Map<AutomergeUrl, SourceListener>;
    queued: boolean;
    debounce: ReturnType<typeof setTimeout> | null;
  };

  const tasks = new Map<AutomergeUrl, Task>();
  const queue: AutomergeUrl[] = [];
  let running = false;
  let disposed = false;

  // Host-doc creation times, resolved once per root url.
  const creationTimes = new Map<AutomergeUrl, Promise<number | undefined>>();
  const creationTime = (url: AutomergeUrl): Promise<number | undefined> => {
    let cached = creationTimes.get(url);
    if (!cached) {
      cached = getDocCreationTime(repo, url);
      creationTimes.set(url, cached);
    }
    return cached;
  };

  function sync(specs: TimelineSpec[]): void {
    if (disposed) return;
    const keep = new Set(specs.map((s) => s.draftHandle.url));
    for (const [key, task] of [...tasks]) {
      if (!keep.has(key)) removeTask(task);
    }
    for (const spec of specs) {
      const key = spec.draftHandle.url;
      let task = tasks.get(key);
      const membersChanged =
        !task || !sameMemberSets(task.spec.members, spec.members);
      if (!task) {
        task = { key, spec, listeners: new Map(), queued: false, debounce: null };
        tasks.set(key, task);
      } else {
        task.spec = spec;
      }
      void ensureListeners(task);
      if (membersChanged) schedule(key);
    }
  }

  function dispose(): void {
    disposed = true;
    for (const [, task] of [...tasks]) removeTask(task);
    queue.length = 0;
  }

  return { sync, dispose };

  function removeTask(task: Task): void {
    if (task.debounce) clearTimeout(task.debounce);
    task.debounce = null;
    for (const [, { handle, onChange }] of task.listeners) {
      handle?.off("change", onChange);
    }
    task.listeners.clear();
    // A queued entry is skipped by the pump once the task is gone.
    tasks.delete(task.key);
  }

  function sameMemberSets(a: DraftMemberDoc[], b: DraftMemberDoc[]): boolean {
    if (a.length !== b.length) return false;
    const key = (m: DraftMemberDoc) => `${m.url}:${m.cloneUrl ?? ""}`;
    const set = new Set(a.map(key));
    return b.every((m) => set.has(key(m)));
  }

  // Keep exactly one change listener per member source doc; edits schedule a
  // debounced incremental fill of the owning timeline.
  async function ensureListeners(task: Task): Promise<void> {
    const wanted = new Set(
      task.spec.members.map((m) => m.cloneUrl ?? m.url)
    );
    for (const [url, { handle, onChange }] of [...task.listeners]) {
      if (!wanted.has(url)) {
        handle?.off("change", onChange);
        task.listeners.delete(url);
      }
    }
    for (const url of wanted) {
      if (task.listeners.has(url)) continue;
      const onChange = () => {
        if (task.debounce) clearTimeout(task.debounce);
        task.debounce = setTimeout(() => {
          task.debounce = null;
          schedule(task.key);
        }, FILL_DEBOUNCE_MS);
      };
      const slot: SourceListener = { handle: null, onChange };
      task.listeners.set(url, slot);
      try {
        const handle = await repo.find<unknown>(url);
        // The task was torn down or the slot dropped while resolving.
        if (disposed || tasks.get(task.key) !== task) return;
        if (task.listeners.get(url) !== slot) return;
        handle.on("change", onChange);
        slot.handle = handle;
      } catch (err) {
        if (task.listeners.get(url) === slot) task.listeners.delete(url);
        console.warn(
          "[drafts] change-group cache: failed to watch member:",
          url,
          err
        );
      }
    }
  }

  function schedule(key: AutomergeUrl): void {
    if (disposed) return;
    const task = tasks.get(key);
    if (!task || task.queued) return;
    task.queued = true;
    queue.push(key);
    void pump();
  }

  async function pump(): Promise<void> {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length > 0 && !disposed) {
        const key = queue.shift()!;
        const task = tasks.get(key);
        if (!task) continue;
        task.queued = false;
        try {
          await fillTimeline(task);
        } catch (err) {
          console.warn(
            "[drafts] change-group cache fill failed for:",
            key,
            err
          );
        }
      }
    } finally {
      running = false;
    }
  }

  // One fill pass over a timeline. The common case appends the unconsumed
  // tail onto the newest group; anything that would reshape older groups
  // (late-syncing changes, a fresh cache) falls back to a full rebuild that
  // reuses stored groups wherever they come out identical.
  async function fillTimeline(task: Task): Promise<void> {
    const spec = task.spec;
    // The run is stale once the task was replaced or torn down (a newer spec
    // re-queues itself), or the filler disposed.
    const isAborted = () => disposed || tasks.get(task.key) !== task;

    if (!spec.draftHandle.doc()) return;
    const cacheHandle = await ensureChangeGroupCache(repo, spec.draftHandle);
    const createdAt = await creationTime(spec.rootDocUrl);
    if (isAborted()) return;

    // Resolve member sources, sorted by member url so cross-doc timestamp
    // ties interleave identically on every client.
    const members = [...spec.members].sort(byMemberUrl);
    const sources: { member: DraftMemberDoc; doc: Automerge.Doc<unknown> }[] =
      [];
    for (const member of members) {
      try {
        const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
        const doc = handle.doc();
        if (doc) sources.push({ member, doc: doc as Automerge.Doc<unknown> });
      } catch (err) {
        console.warn(
          "[drafts] change-group cache: failed to resolve member:",
          member,
          err
        );
      }
    }
    if (isAborted()) return;

    const cacheDoc = cacheHandle.doc();
    if (!cacheDoc) return;
    const computedThrough = cacheDoc.computedThrough ?? {};

    // Each member's frontier as of this gather; the consumed marker advances
    // to exactly these once the run completes, so the next run's
    // getChangesMetaSince yields precisely the unconsumed tail.
    const frontier: Record<AutomergeUrl, UrlHeads> = {};
    const tails: PendingChange[] = [];
    for (const { member, doc } of sources) {
      frontier[member.url] = encodeHeads(Automerge.getHeads(doc));
      const consumed = computedThrough[member.url];
      const since = consumed
        ? decodeHeads(consumed)
        : member.clonedAt
          ? decodeHeads(member.clonedAt)
          : [];
      collectMemberRows(tails, member, doc, since, createdAt);
    }

    if (tails.length === 0) {
      // Nothing new to group; just record any frontier movement (e.g. members
      // whose unconsumed changes were all filtered out, or brand-new members
      // with no post-fork changes yet).
      const stale = Object.entries(frontier).filter(
        ([url, heads]) => !sameHeads(computedThrough[url as AutomergeUrl], heads)
      );
      if (stale.length > 0) {
        cacheHandle.change((d) => {
          for (const [url, heads] of stale) {
            d.computedThrough[url as AutomergeUrl] = heads;
          }
        });
      }
      return;
    }

    tails.sort(newestFirst);

    // Fast path: every new change lands on or after the newest stored group
    // (extending it or opening newer ones) without bridging into the group
    // below it — the overwhelmingly common live-editing case. Everything else
    // (first build, members without a consumed marker, late-syncing changes
    // with old timestamps) rebuilds via the full pass.
    const stored = Object.values(cacheDoc.groups ?? {}).sort(
      (a, b) => b.endTime - a.endTime
    );
    const newestStored = stored[0];
    const secondStored = stored[1];
    const tailOldestMs = tails[tails.length - 1].time * 1000;
    const fastOk =
      !!newestStored &&
      tailOldestMs >= newestStored.startTime * 1000 - INACTIVITY_GAP_MS &&
      (!secondStored ||
        tailOldestMs - secondStored.endTime * 1000 > INACTIVITY_GAP_MS);

    if (fastOk) {
      await appendTail(cacheHandle, newestStored, tails, frontier, isAborted);
    } else {
      await rebuildAll(cacheHandle, sources, createdAt, frontier, isAborted);
    }
  }

  // Incremental append: diff only the tail, then extend the newest stored
  // group (accumulate counts, union actors, bump the anchor) and/or open new
  // groups above it. No stored aggregate is ever decomposed.
  async function appendTail(
    cacheHandle: DocHandle<ChangeGroupCacheDoc>,
    newestStored: CachedGroup,
    tailsNewestFirst: PendingChange[],
    frontier: Record<AutomergeUrl, UrlHeads>,
    isAborted: () => boolean
  ): Promise<void> {
    const tailGroups = splitIntoGroups(tailsNewestFirst);
    const oldestGroup = tailGroups[tailGroups.length - 1];
    const oldestGroupOldestMs =
      oldestGroup[oldestGroup.length - 1].time * 1000;
    // The oldest run of new changes merges into the stored group when no lull
    // separates them (it may even start inside the stored span).
    const attaches =
      oldestGroupOldestMs <= newestStored.endTime * 1000 + INACTIVITY_GAP_MS;
    const freshGroups = attaches ? tailGroups.slice(0, -1) : tailGroups;

    const slicer = createSlicer(isAborted, () => {});
    const built: CachedGroup[] = [];
    for (const rows of freshGroups) {
      const group = await buildGroup(rows, slicer);
      if (group === null) return;
      built.push(group);
    }

    let extensionSums: { additions: number; deletions: number } | null = null;
    if (attaches) {
      let additions = 0;
      let deletions = 0;
      for (const row of oldestGroup) {
        if (!(await slicer.tick())) return;
        const counts = computeEditCounts(row.doc, row.hash, row.deps);
        additions += counts.additions;
        deletions += counts.deletions;
      }
      extensionSums = { additions, deletions };
    }

    if (isAborted()) return;
    cacheHandle.change((d) => {
      for (const group of built) d.groups[group.id] = group;
      if (attaches && extensionSums) {
        extendGroup(d, newestStored, oldestGroup, extensionSums);
      }
      for (const [url, heads] of Object.entries(frontier)) {
        d.computedThrough[url as AutomergeUrl] = heads;
      }
    });
  }

  // Fold a tail run into the newest stored group inside an open change():
  // re-read the group from the live doc so a concurrently synced extension is
  // extended further rather than clobbered.
  function extendGroup(
    d: ChangeGroupCacheDoc,
    storedSnapshot: CachedGroup,
    tailNewestFirst: PendingChange[],
    sums: { additions: number; deletions: number }
  ): void {
    const tailNewest = tailNewestFirst[0];
    const tailOldest = tailNewestFirst[tailNewestFirst.length - 1];
    const base = d.groups[storedSnapshot.id];
    if (!base) {
      // The stored group vanished under us (concurrent rewrite); keep the
      // tail as its own group rather than losing it — the next full pass
      // reconciles the shape.
      d.groups[`tg-${tailNewest.hash}`] = {
        id: `tg-${tailNewest.hash}`,
        startTime: tailOldest.time,
        endTime: tailNewest.time,
        newestMemberUrl: tailNewest.memberUrl,
        newestHash: tailNewest.hash,
        actors: dedupedActors(tailNewestFirst),
        additions: sums.additions,
        deletions: sums.deletions,
        changeCount: tailNewestFirst.length,
      };
      return;
    }

    // The tail is newer causally, but a merge can deliver changes stamped
    // inside the stored span; only a strictly later timestamp moves the
    // anchor.
    const newer = tailNewest.time > base.endTime;
    const tailActors = dedupedActors(tailNewestFirst);
    const baseActors = [...base.actors];
    const actors = newer
      ? [...tailActors, ...baseActors.filter((a) => !tailActors.includes(a))]
      : [...baseActors, ...tailActors.filter((a) => !baseActors.includes(a))];

    const extended: CachedGroup = {
      id: newer ? `tg-${tailNewest.hash}` : base.id,
      startTime: Math.min(base.startTime, tailOldest.time),
      endTime: Math.max(base.endTime, tailNewest.time),
      newestMemberUrl: newer ? tailNewest.memberUrl : base.newestMemberUrl,
      newestHash: newer ? tailNewest.hash : base.newestHash,
      actors,
      additions: base.additions + sums.additions,
      deletions: base.deletions + sums.deletions,
      changeCount: base.changeCount + tailNewestFirst.length,
    };
    if (extended.id !== storedSnapshot.id) delete d.groups[storedSnapshot.id];
    d.groups[extended.id] = extended;
  }

  // Full rebuild: regather every member's post-fork history, re-split, and
  // diff newest-first in idle slices — flushing completed groups as each
  // slice ends so recent history paints while older history backfills. A
  // stored group whose id, span, and change count match is reused without
  // re-diffing (cheap warm restarts, and no redundant work when another
  // client's fill syncs in). Stale ids and the consumed markers settle in the
  // final write.
  async function rebuildAll(
    cacheHandle: DocHandle<ChangeGroupCacheDoc>,
    sources: { member: DraftMemberDoc; doc: Automerge.Doc<unknown> }[],
    createdAt: number | undefined,
    frontier: Record<AutomergeUrl, UrlHeads>,
    isAborted: () => boolean
  ): Promise<void> {
    const rows: PendingChange[] = [];
    for (const { member, doc } of sources) {
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      collectMemberRows(rows, member, doc, since, createdAt);
    }
    rows.sort(newestFirst);
    const groupsRows = splitIntoGroups(rows);
    const expectedIds = new Set(groupsRows.map(groupId));

    const batch: CachedGroup[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      cacheHandle.change((d) => {
        for (const group of batch) d.groups[group.id] = group;
      });
      batch.length = 0;
    };

    const slicer = createSlicer(isAborted, flush);
    for (const groupRows of groupsRows) {
      const id = groupId(groupRows);
      const existing = cacheHandle.doc()?.groups?.[id];
      if (
        existing &&
        existing.changeCount === groupRows.length &&
        existing.startTime === groupRows[groupRows.length - 1].time &&
        existing.endTime === groupRows[0].time
      ) {
        continue;
      }
      const group = await buildGroup(groupRows, slicer);
      if (group === null) return; // aborted mid-diff; markers stay put
      batch.push(group);
    }

    if (isAborted()) return;
    cacheHandle.change((d) => {
      for (const group of batch) d.groups[group.id] = group;
      for (const id of Object.keys(d.groups)) {
        if (!expectedIds.has(id)) delete d.groups[id];
      }
      for (const [url, heads] of Object.entries(frontier)) {
        d.computedThrough[url as AutomergeUrl] = heads;
      }
    });
  }
}
