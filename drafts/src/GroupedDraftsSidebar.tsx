import "./styles.css";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import { createDocSignal } from "@automerge/automerge-repo-solid-primitives";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
  UrlHeads,
} from "@automerge/automerge-repo";
import { decodeHeads, encodeHeads } from "@automerge/automerge-repo";
import * as Automerge from "@automerge/automerge";
import { getRegistry, isLoadedPlugin } from "@inkandswitch/patchwork-plugins";
import {
  subscribe,
  subscribeDoc,
} from "@inkandswitch/patchwork-providers-solid";
import type {
  CheckedOutDraft,
  CloneEntry,
  DraftCheckpoint,
  DraftDoc,
  DraftList,
  DraftMemberDoc,
  HasDrafts,
} from "./draft-types";

// Seed for the read-only `draft:list` subscription until the provider answers.
// `main.url` is a placeholder; the Main card displays the host doc url instead.
const EMPTY_DRAFT_LIST: DraftList = {
  main: { url: "" as AutomergeUrl, members: [], childCount: 0 },
  drafts: [],
};

// Bump on each deploy to eyeball whether the latest build has synced.
const DRAFTS_VERSION = "0.0.5";

// A pause between consecutive changes longer than this starts a new group:
// bursts of continuous editing read as a single row, however long they run,
// and any minute-plus lull splits the timeline.
const INACTIVITY_GAP = 60 * 1000;

export function GroupedDraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = subscribeDoc<HasDrafts>(props.element, {
    type: "draft:root-doc",
  });

  // Selection only: which draft is checked out (writeable).
  const [, checkedOutHandle] = subscribeDoc<CheckedOutDraft>(props.element, {
    type: "draft:checked-out",
  });

  // Read the checkout doc coarsely from the live handle (handle.doc()) rather
  // than a fine-grained patch-replay projection: the projection can render a
  // whole-value write doubled, whereas handle.doc() is always the correct
  // materialized document.
  const checkedOut = createDocSignal(checkedOutHandle);
  const selected = createMemo<AutomergeUrl | null>(
    () => checkedOut()?.checkedOut ?? null
  );

  // Where the scrubber sits: the change whose heads are displayed plus how
  // many timeline changes back the diff baseline reaches (0 = no diff).
  // Ephemeral, client-only state: the stored checkpoint (`checkedOut.at`) is
  // what actually pins the view; this mirrors it to render the token, the
  // group highlight, and the eye toggles. Not persisted, so it resets on
  // reload (the pinned view survives).
  const [scrubber, setScrubber] = createSignal<ScrubberState | null>(null);

  // The derived drafts list (read-only): main plus each draft with its member
  // docs, recomputed and pushed by the provider.
  const list = subscribe<DraftList>(
    props.element,
    { type: "draft:list" },
    EMPTY_DRAFT_LIST
  );

  const isMainSelected = createMemo(() => selected() === null);
  // Drafting off a folder isn't supported yet, so creating a draft is disabled
  // while viewing a folder on Main.
  const isFolder = createMemo(
    () => hostDoc()?.["@patchwork"]?.type === "folder"
  );

  const selectDraft = (url: AutomergeUrl | null) => {
    const handle = checkedOutHandle();
    if (!handle) return;
    setScrubber(null);
    handle.change((d) => {
      d.checkedOut = url;
      // Switching drafts (or to main) returns to the live latest heads.
      d.at = null;
    });
  };

  const getRepo = (): Repo | undefined =>
    "repo" in window ? window.repo : undefined;

  // Monotonic counter so a slow checkpoint computation can't overwrite a newer
  // scrub position (a drag fires one recompute per snapped change).
  let scrubSeq = 0;

  // Apply a scrubber position: freeze every member doc at its heads as of the
  // scrub head, diffed against the state just before `baseline` — the oldest
  // change the scrubber spans — or not diffed at all when `baseline` is null.
  // The token and row highlight update immediately; the checkpoint follows
  // async. `draftUrl` is `null` for main.
  const onScrub = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    scrub: ScrubberState,
    baseline: ChangeRef | null
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    setScrubber(scrub);
    const seq = ++scrubSeq;
    void (async () => {
      const checkpoint = await computeCheckpoint(
        repo,
        members,
        scrub.head,
        baseline
      );
      // A newer scrub landed while this one was computing; drop it.
      if (seq !== scrubSeq) return;
      handle.change((d) => {
        d.checkedOut = draftUrl;
        d.at = checkpoint;
      });
    })();
  };

  // Drop the time pin but stay on the same draft: back to live latest heads.
  const clearCheckpoint = () => {
    const handle = checkedOutHandle();
    if (!handle) return;
    setScrubber(null);
    handle.change((d) => {
      d.at = null;
    });
  };

  const onCreateDraft = async () => {
    if (isFolder()) return;
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }

    // Top-level drafts branch off the main draft and live in its `drafts`
    // list. The main draft is created lazily the first time we draft this doc.
    const mainDraft = await ensureMainDraft(repo, docHandle);
    const draft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parent: mainDraft.url,
      drafts: [],
      clones: {},
    });
    mainDraft.change((d) => {
      d.drafts.push(draft.url);
    });
    selectDraft(draft.url);
  };

  // Resolve the host doc's single main draft, creating it (and pointing
  // `@patchwork.mainDraftUrl` at it) the first time. The main draft is
  // bookkeeping only: the list provider seeds its identity `clones`, and its
  // `drafts` holds the top-level draft list.
  const ensureMainDraft = async (
    repo: Repo,
    docHandle: DocHandle<HasDrafts>
  ): Promise<DocHandle<DraftDoc>> => {
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
      d["@patchwork"]!.mainDraftUrl = mainDraft.url;
    });
    return mainDraft;
  };

  const onMergeDraft = async () => {
    const draftUrl = selected();
    if (!draftUrl) return;
    if (!window.confirm("Merge this draft into the main document?")) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }
    const draftHandle = await repo.find<DraftDoc>(draftUrl);
    await mergeDraft(repo, draftHandle);
    selectDraft(null);
  };

  return (
    <div class="drafts-panel">
      <Show
        when={hostDoc()}
        fallback={<div class="drafts-empty">No document selected.</div>}
      >
        <div class="drafts-list">
          <MainCard
            hostDocUrl={hostDocHandle()?.url}
            isSelected={isMainSelected()}
            members={() => list().main.members}
            onSelect={() => selectDraft(null)}
            onScrub={(scrub, baseline) =>
              onScrub(null, list().main.members, scrub, baseline)
            }
            scrubber={() => (isMainSelected() ? scrubber() : null)}
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                members={summary.members}
                mainDocUrl={hostDocHandle()?.url}
                isSelected={selected() === summary.url}
                onSelect={selectDraft}
                onScrub={(scrub, baseline) =>
                  onScrub(summary.url, summary.members, scrub, baseline)
                }
                scrubber={() =>
                  selected() === summary.url ? scrubber() : null
                }
              />
            )}
          </For>
        </div>
        <div class="drafts-actions">
          <Show when={checkedOut()?.at}>
            <button
              class="drafts-btn drafts-btn--ghost"
              onClick={clearCheckpoint}
              title="Return to the latest version"
            >
              Return to latest
            </button>
          </Show>
          <Show when={isMainSelected()}>
            <button
              class="drafts-btn drafts-btn--primary"
              disabled={isFolder()}
              onClick={onCreateDraft}
              title={
                isFolder()
                  ? "Drafts aren't supported for folders yet"
                  : "Create a new draft off this document"
              }
            >
              New draft
            </button>
            <Show when={isFolder()}>
              <span class="drafts-hint">
                Drafts aren't supported for folders yet.
              </span>
            </Show>
          </Show>
          <Show when={!isMainSelected()}>
            <button
              class="drafts-btn drafts-btn--warning"
              onClick={onMergeDraft}
              title="Merge this draft into Main"
            >
              Merge into Main
            </button>
          </Show>
        </div>
      </Show>
      <div class="drafts-version">v{DRAFTS_VERSION}</div>
    </div>
  );
}

// Merges every cloned doc back into its original, recording per-clone
// merge heads for auditing, and marks the draft as merged.
async function mergeDraft(
  repo: Repo,
  draftHandle: DocHandle<DraftDoc>
): Promise<void> {
  const entries = Object.entries(draftHandle.doc()?.clones ?? {}) as [
    AutomergeUrl,
    CloneEntry,
  ][];
  for (const [originalUrl, entry] of entries) {
    if (entry.cloneUrl === originalUrl) continue;
    const [original, clone] = await Promise.all([
      repo.find<unknown>(originalUrl),
      repo.find<unknown>(entry.cloneUrl),
    ]);
    original.merge(clone);
    const mergedAt = original.heads();
    draftHandle.change((d) => {
      const e = d.clones[originalUrl];
      if (e) e.mergedAt = mergedAt;
    });
  }
  draftHandle.change((d) => {
    d.mergedAt = Date.now();
  });
}

function MainCard(props: {
  hostDocUrl: AutomergeUrl | undefined;
  isSelected: boolean;
  members: Accessor<DraftMemberDoc[]>;
  onSelect: () => void;
  onScrub: (scrub: ScrubberState, baseline: ChangeRef | null) => void;
  scrubber: Accessor<ScrubberState | null>;
}) {
  return (
    <div class="draft-card" data-selected={props.isSelected ? "" : undefined}>
      <button
        type="button"
        class="draft-card-header"
        onClick={props.onSelect}
        title="Main version (host document)"
      >
        <div class="draft-card-title">
          <span>Main</span>
          <Show when={props.isSelected}>
            <span class="draft-badge">current</span>
          </Show>
        </div>
      </button>
      <Show when={props.isSelected}>
        <DraftChangesList
          members={props.members}
          mainDocUrl={props.hostDocUrl}
          onScrub={props.onScrub}
          scrubber={props.scrubber}
        />
      </Show>
    </div>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  members: DraftMemberDoc[];
  mainDocUrl: AutomergeUrl | undefined;
  isSelected: boolean;
  onSelect: (url: AutomergeUrl) => void;
  onScrub: (scrub: ScrubberState, baseline: ChangeRef | null) => void;
  scrubber: Accessor<ScrubberState | null>;
}) {
  return (
    <div class="draft-card" data-selected={props.isSelected ? "" : undefined}>
      <button
        type="button"
        class="draft-card-header"
        onClick={() => props.onSelect(props.url)}
        title="Open draft"
      >
        <div class="draft-card-title">
          <span>Draft</span>
          <Show when={props.isSelected}>
            <span class="draft-badge">current</span>
          </Show>
        </div>
      </button>
      <Show when={props.isSelected}>
        <DraftChangesList
          members={() => props.members}
          mainDocUrl={props.mainDocUrl}
          onScrub={props.onScrub}
          scrubber={props.scrubber}
        />
      </Show>
    </div>
  );
}

// One change in the interleaved timeline. `docUrl` is the original member url
// (used for labelling and as the checkpoint anchor), never the per-draft clone
// the change was read from. `title` is the source document's display title.
// `seq` is the change's per-document causal index, used only to break
// timestamp ties (see `collectInterleavedChanges`). `additions`/`deletions`
// are the change's rough edit magnitude, aggregated for the group +/- counts.
type DraftChange = {
  docUrl: AutomergeUrl;
  title: string;
  hash: string;
  // Automerge change time, in SECONDS (multiply by 1000 for a JS Date).
  time: number;
  actor: string;
  message: string | null;
  seq: number;
  additions: number;
  deletions: number;
};

// One burst of activity: consecutive changes separated by no more than
// INACTIVITY_GAP, regardless of author or document. Rendered as a single
// non-expandable row. Clicking it parks the scrubber at `newest` (no
// diff); the row's eye expands the scrubber across the whole group, with
// `oldest` anchoring the diff baseline (the state just before the group
// started).
type TimeGroup = {
  id: string;
  endTime: number;
  actors: string[];
  additions: number;
  deletions: number;
  newest: DraftChange;
  oldest: DraftChange;
  changes: DraftChange[];
};

// A reference to one change in the interleaved timeline, by document and
// hash. `time` steers how the *other* member docs' heads are resolved around
// it (see `computeCheckpoint`).
type ChangeRef = {
  docUrl: AutomergeUrl;
  hash: string;
  time: number;
};

// Where the scrubber sits. `head` is the change whose heads the view
// displays; `span` is how many timeline changes the diff reaches back from
// the head — the baseline is the state just before the span's oldest change,
// so 0 means no diff (baseline == displayed heads). The head is anchored by
// change identity rather than index so a recomputed timeline doesn't move
// the token.
type ScrubberState = {
  head: ChangeRef;
  span: number;
};

// Strip a timeline change down to the fields that identify it for scrubbing.
function changeRef(change: DraftChange): ChangeRef {
  return { docUrl: change.docUrl, hash: change.hash, time: change.time };
}

// A magnified stretch of the timeline: the range the scrubber spanned when
// the magnifier was clicked (same anchoring as ScrubberState) plus the finer
// grouping gap to apply inside it. The rest of the timeline keeps the normal
// INACTIVITY_GAP grouping.
type ZoomState = {
  head: ChangeRef;
  span: number;
  windowMs: number;
};

// Renders a draft's (or main's) changes as a timeline of activity groups:
// every member doc's changes interleaved newest first, then split wherever
// the editing paused for INACTIVITY_GAP (see `groupChanges`). A
// gutter on the left spans the whole history (top = latest change, bottom =
// first); the indicator overlaying the rows — a calendar-style dot + line,
// drawn as a bracket while it spans a range — marks the version being looked
// at and how far back the diff baseline reaches, and carries a magnifier
// that splits the spanned range into smaller time chunks. The member set is
// passed in (from the card's `DraftSummary`); the effect below keeps the
// timeline live as those docs edit.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  mainDocUrl: AutomergeUrl | undefined;
  onScrub: (scrub: ScrubberState, baseline: ChangeRef | null) => void;
  scrubber: Accessor<ScrubberState | null>;
}) {
  const [changes, setChanges] = createSignal<DraftChange[]>([]);

  // Whenever the member set changes, resolve a handle per member, listen for
  // edits so the timeline stays live, and recompute. A `disposed` flag guards
  // against the async resolution landing after the effect was torn down.
  createEffect(() => {
    const list = props.members();
    const mainDocUrl = props.mainDocUrl;
    const repo = "repo" in window ? window.repo : undefined;
    if (!repo) return;

    let disposed = false;
    const listeners: { handle: DocHandle<unknown>; onChange: () => void }[] =
      [];

    const recompute = async () => {
      const next = await collectInterleavedChanges(repo, list, mainDocUrl);
      if (!disposed) setChanges(next);
    };

    void (async () => {
      for (const member of list) {
        const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
        if (disposed) return;
        const onChange = () => void recompute();
        handle.on("change", onChange);
        listeners.push({ handle, onChange });
      }
      void recompute();
    })();

    onCleanup(() => {
      disposed = true;
      for (const { handle, onChange } of listeners) {
        handle.off("change", onChange);
      }
    });
  });

  // A magnified range: while set, the changes inside it are grouped with a
  // finer window so one coarse group splits into smaller time chunks.
  // Client-only. It stays split while the scrubber roams (re-clicking the
  // magnifier elsewhere re-anchors it) and folds back when the scrubber
  // unpins entirely.
  const [zoom, setZoom] = createSignal<ZoomState | null>(null);

  createEffect(() => {
    if (!props.scrubber()) setZoom(null);
  });

  // The flat, newest-first history folded into time groups for rendering.
  // A zoomed range is grouped with its finer window; everything before and
  // after it keeps the normal window. (A group that would have straddled the
  // zoom boundary splits there, which is the point.)
  const timeGroups = createMemo(() => {
    const list = changes();
    const z = zoom();
    if (z) {
      const start = list.findIndex(
        (c) => c.hash === z.head.hash && c.docUrl === z.head.docUrl
      );
      if (start >= 0) {
        const end = Math.min(start + z.span, list.length);
        return [
          ...groupChanges(list.slice(0, start)),
          ...groupChanges(list.slice(start, end), z.windowMs),
          ...groupChanges(list.slice(end)),
        ];
      }
    }
    return groupChanges(list);
  });

  // The magnifier is lit while the zoom covers exactly the scrubber's
  // current range.
  const zoomActive = createMemo(() => {
    const z = zoom();
    const s = props.scrubber();
    return (
      !!z &&
      !!s &&
      z.head.hash === s.head.hash &&
      z.head.docUrl === s.head.docUrl &&
      z.span === s.span
    );
  });

  // Toggle the magnifier: split the scrubber's current range into smaller
  // time chunks (window sized so the range yields a handful of subgroups),
  // or fold it back to the normal grouping when already split.
  const toggleZoom = () => {
    const s = props.scrubber();
    const hi = headIndex();
    if (!s || hi === null || s.span === 0) return;
    if (zoomActive()) {
      setZoom(null);
      return;
    }
    const list = changes();
    const end = Math.min(hi + s.span, list.length);
    const extentMs = (list[hi].time - list[end - 1].time) * 1000;
    setZoom({
      head: s.head,
      span: s.span,
      windowMs: Math.max(extentMs / 4, 1000),
    });
  };

  // Scrub so the head sits at the timeline change at `headIndex` (global,
  // 0 = newest), spanning `span` changes back. Resolves the span's oldest
  // change as the baseline anchor and reports both upward.
  const scrubTo = (headIndex: number, span: number) => {
    const list = changes();
    const head = list[headIndex];
    if (!head) return;
    const clamped = Math.max(0, Math.min(span, list.length - headIndex));
    const base = clamped >= 1 ? list[headIndex + clamped - 1] : null;
    props.onScrub(
      { head: changeRef(head), span: clamped },
      base ? changeRef(base) : null
    );
  };

  // Jump the scrubber to a group: head at the group's newest change, either
  // spanning the whole group (`withDiff`: baseline = just before the group
  // started, showing exactly what it introduced) or collapsed to a point
  // (baseline = the group's latest heads, so nothing is diffed).
  const scrubToGroup = (group: TimeGroup, withDiff: boolean) => {
    props.onScrub(
      {
        head: changeRef(group.newest),
        span: withDiff ? group.changes.length : 0,
      },
      withDiff ? changeRef(group.oldest) : null
    );
  };

  // Where the scrubber head sits in the flat timeline; null when nothing is
  // pinned (live latest) or the anchored change vanished from a recompute.
  const headIndex = createMemo<number | null>(() => {
    const s = props.scrubber();
    if (!s) return null;
    const idx = changes().findIndex(
      (c) => c.hash === s.head.hash && c.docUrl === s.head.docUrl
    );
    return idx >= 0 ? idx : null;
  });

  const groupContainsHead = (group: TimeGroup): boolean => {
    const s = props.scrubber();
    return (
      !!s &&
      group.changes.some(
        (c) => c.hash === s.head.hash && c.docUrl === s.head.docUrl
      )
    );
  };

  // The eye is lit when the scrubber spans exactly this whole group.
  const eyeActive = (group: TimeGroup): boolean => {
    const s = props.scrubber();
    return (
      !!s &&
      s.head.hash === group.newest.hash &&
      s.head.docUrl === group.newest.docUrl &&
      s.span === group.changes.length
    );
  };

  // --- Scrubber geometry ---------------------------------------------------
  // The track mirrors the rows column: each group row is one vertical band,
  // and the group's changes distribute evenly across the band's height, so
  // every individual change — including ones in the middle of a group — is a
  // valid stop for the token, not just group boundaries.
  const rowEls = new Map<string, HTMLElement>();
  const [rowsEl, setRowsEl] = createSignal<HTMLDivElement>();
  // Bumped after layout changes so `bands` re-measures the rendered rows.
  const [measureTick, setMeasureTick] = createSignal(0);

  createEffect(() => {
    const el = rowsEl();
    if (!el) return;
    const observer = new ResizeObserver(() => setMeasureTick((t) => t + 1));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  // Rows render after the groups memo recomputes, so measure again on the
  // next frame once the DOM has settled.
  createEffect(() => {
    timeGroups();
    requestAnimationFrame(() => setMeasureTick((t) => t + 1));
  });

  type Band = {
    startIndex: number;
    count: number;
    top: number;
    height: number;
  };
  const bands = createMemo<Band[]>(() => {
    measureTick();
    const out: Band[] = [];
    let index = 0;
    for (const group of timeGroups()) {
      const el = rowEls.get(group.id);
      if (el) {
        out.push({
          startIndex: index,
          count: group.changes.length,
          top: el.offsetTop,
          height: el.offsetHeight,
        });
      }
      index += group.changes.length;
    }
    return out;
  });

  // Map a global change index to a y offset in the track. Indices interpolate
  // across their group's band; `index === changes().length` (the far edge of
  // a span reaching past the oldest change) maps to the very bottom.
  const yForIndex = (index: number): number => {
    const bs = bands();
    if (bs.length === 0) return 0;
    for (const b of bs) {
      if (index < b.startIndex + b.count) {
        return b.top + ((index - b.startIndex) / b.count) * b.height;
      }
    }
    const last = bs[bs.length - 1];
    return last.top + last.height;
  };

  // Inverse: the change index nearest a pointer y (in track coordinates).
  const indexForY = (y: number): number => {
    const bs = bands();
    if (bs.length === 0) return 0;
    for (const b of bs) {
      if (y < b.top) return b.startIndex;
      if (y < b.top + b.height) {
        const idx =
          b.startIndex + Math.round(((y - b.top) / b.height) * b.count);
        return Math.min(idx, b.startIndex + b.count - 1);
      }
    }
    const last = bs[bs.length - 1];
    return Math.max(0, last.startIndex + last.count - 1);
  };

  // The indicator's pixel extent: top edge at the head, bottom edge at the
  // far end of the span. Height 0 is fine — the dot and edge lines overflow
  // the box and stay grabbable. With nothing pinned it idles at the very
  // top — you're looking at the live latest.
  const tokenGeometry = createMemo(() => {
    const total = changes().length;
    if (total === 0 || bands().length === 0) return null;
    const head = headIndex() ?? 0;
    const span =
      headIndex() === null
        ? 0
        : Math.min(props.scrubber()?.span ?? 0, total - head);
    const top = yForIndex(head);
    const bottom = yForIndex(head + span);
    return { top, height: Math.max(bottom - top, 0) };
  });

  // Spread = the scrubber spans at least one change back, so the indicator
  // draws as a bracket (top line, spine, bottom line) instead of a plain
  // calendar-style now-line.
  const spread = (): boolean =>
    headIndex() !== null && (props.scrubber()?.span ?? 0) > 0;

  let trackEl: HTMLDivElement | undefined;

  // Pointer y relative to the track's top edge. The rect is re-read per event
  // so scrolling the card mid-drag stays accurate.
  const yInTrack = (ev: PointerEvent): number => {
    const rect = trackEl!.getBoundingClientRect();
    return ev.clientY - rect.top;
  };

  // Begin an indicator drag. `mode` decides what the pointer moves:
  //   - "move":   the whole indicator (dot, spine, or collapsed line); the
  //               head follows the pointer (offset by where it was grabbed),
  //               span preserved.
  //   - "jump":   like "move" but snaps immediately — a click/drag on the
  //               bare gutter.
  //   - "bottom": the bottom line; resizes the span (how far back the diff
  //               reaches). Dragging above the head collapses to no diff.
  //   - "top":    the top line while spread; moves the head while the bottom
  //               anchor stays pinned, adjusting head and span together.
  // Every position snaps to an individual change, so the indicator can rest
  // anywhere in history — between groups or in the middle of one.
  const beginDrag = (ev: PointerEvent, mode: "move" | "jump" | "top" | "bottom") => {
    if (!trackEl || changes().length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const total = changes().length;
    const startHead = headIndex() ?? 0;
    const startSpan = Math.min(
      headIndex() === null ? 0 : (props.scrubber()?.span ?? 0),
      total - startHead
    );
    const bottomIndex = startHead + startSpan;
    const grabOffset = mode === "move" ? yInTrack(ev) - yForIndex(startHead) : 0;

    let last = { head: startHead, span: startSpan };
    const apply = (head: number, span: number) => {
      if (head === last.head && span === last.span) return;
      last = { head, span };
      scrubTo(head, span);
    };

    const onMove = (e: PointerEvent) => {
      const y = yInTrack(e);
      if (mode === "move" || mode === "jump") {
        apply(indexForY(y - grabOffset), last.span);
      } else if (mode === "bottom") {
        apply(last.head, Math.max(0, indexForY(y) - last.head + 1));
      } else {
        const head = Math.min(indexForY(y), bottomIndex, total - 1);
        apply(head, Math.max(0, bottomIndex - head));
      }
    };

    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
    if (mode === "jump") onMove(ev);
  };

  return (
    <div class="draft-card-changes">
      <Show
        when={timeGroups().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <div class="draft-changes-body">
          <div
            class="draft-scrubber"
            ref={trackEl}
            title="Drag to scrub through history"
            onPointerDown={(e) => beginDrag(e, "jump")}
          />
          <div class="draft-changes-rows" ref={setRowsEl}>
            <For each={timeGroups()}>
              {(group) => (
                <TimeGroupRow
                  group={group}
                  rowRef={(el) => rowEls.set(group.id, el)}
                  isSelected={groupContainsHead(group)}
                  eyeActive={eyeActive(group)}
                  onSelect={() => scrubToGroup(group, false)}
                  onToggleEye={() => scrubToGroup(group, !eyeActive(group))}
                />
              )}
            </For>
          </div>
          <Show when={tokenGeometry()}>
            <div
              class="draft-scrubber-token"
              data-live={headIndex() === null ? "" : undefined}
              data-spread={spread() ? "" : undefined}
              style={{
                top: `${tokenGeometry()!.top}px`,
                height: `${tokenGeometry()!.height}px`,
              }}
            >
              <div
                class="draft-scrubber-edge draft-scrubber-edge--top"
                title={
                  spread()
                    ? "Drag to move the top of the range"
                    : "Drag to scrub through history"
                }
                onPointerDown={(e) => beginDrag(e, spread() ? "top" : "move")}
              />
              <div
                class="draft-scrubber-edge draft-scrubber-edge--bottom"
                title="Drag to change how far back the diff reaches"
                onPointerDown={(e) => beginDrag(e, "bottom")}
              />
              <Show when={spread()}>
                <div
                  class="draft-scrubber-spine"
                  title="Drag to move the range"
                  onPointerDown={(e) => beginDrag(e, "move")}
                />
              </Show>
              <div
                class="draft-scrubber-dot"
                title="Drag to scrub through history"
                onPointerDown={(e) => beginDrag(e, "move")}
              />
              <Show when={spread()}>
                <button
                  type="button"
                  class="draft-scrubber-zoom"
                  classList={{ "draft-scrubber-zoom--active": zoomActive() }}
                  title="Split this range into smaller time chunks"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleZoom();
                  }}
                >
                  <MagnifierIcon />
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// One time group, rendered as a single non-expandable row: author avatars,
// the group's newest timestamp, an eye toggling the group's diff, and the
// aggregated +/- counts. Clicking the row parks the scrubber at the top of
// the group with no diff; the eye expands it across the whole group. The row
// highlights while the scrubber head sits inside the group.
function TimeGroupRow(props: {
  group: TimeGroup;
  rowRef: (el: HTMLElement) => void;
  isSelected: boolean;
  eyeActive: boolean;
  onSelect: () => void;
  onToggleEye: () => void;
}) {
  return (
    <button
      type="button"
      class="draft-group-row"
      ref={props.rowRef}
      data-selected={props.isSelected ? "" : undefined}
      title="View the draft as of this group"
      onClick={props.onSelect}
    >
      <AuthorAvatars actors={props.group.actors} />
      <span class="draft-group-time">{formatTime(props.group.endTime)}</span>
      <span
        class="draft-highlight-eye"
        classList={{ "draft-highlight-eye--active": props.eyeActive }}
        role="button"
        tabindex={0}
        title="Toggle a diff of what this group changed"
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleEye();
        }}
      >
        <EyeIcon />
      </span>
      <span class="draft-group-spacer" />
      <EditCounts
        additions={props.group.additions}
        deletions={props.group.deletions}
      />
    </button>
  );
}

// An eye glyph for the per-group diff toggle. Revealed on row hover via CSS,
// or kept lit while its group's diff is active.
function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// A magnifying glass for the scrubber's zoom toggle, shown while the
// indicator spans a range.
function MagnifierIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

// A stack of author avatars (deduped), newest-contributor first.
function AuthorAvatars(props: { actors: string[] }) {
  const visible = () => props.actors.slice(0, 3);
  const extra = () => Math.max(0, props.actors.length - 3);
  return (
    <div class="draft-avatars">
      <For each={visible()}>
        {(actor, i) => (
          <div
            class="draft-avatar"
            title={actor}
            style={{
              background: authorColor(actor),
              "margin-left": i() === 0 ? "0" : "-4px",
              "z-index": String(visible().length - i()),
            }}
          >
            {getInitials(actor)}
          </div>
        )}
      </For>
      <Show when={extra() > 0}>
        <div class="draft-avatar draft-avatar--extra">+{extra()}</div>
      </Show>
    </div>
  );
}

// The +N / -N edit-size counts shown at the end of a group row.
function EditCounts(props: { additions: number; deletions: number }) {
  return (
    <span class="draft-counts">
      <Show when={props.additions > 0}>
        <span class="draft-count draft-count--add">+{props.additions}</span>
      </Show>
      <Show when={props.deletions > 0}>
        <span class="draft-count draft-count--del">-{props.deletions}</span>
      </Show>
    </span>
  );
}

// Fold a flat, newest-first list of changes into activity groups. Consecutive
// changes stay in the same group while the pause between them is at most the
// gap (INACTIVITY_GAP unless a magnified range passes a finer one); a longer
// lull starts a new group. A group can span any stretch of continuous editing
// — only inactivity splits it.
function groupChanges(
  changes: DraftChange[],
  gapMs: number = INACTIVITY_GAP
): TimeGroup[] {
  const timeGroups: TimeGroup[] = [];
  let window: DraftChange[] = [];
  let prevTimeMs: number | null = null;

  const flush = () => {
    if (window.length > 0) {
      timeGroups.push(buildTimeGroup(window));
      window = [];
    }
  };

  for (const change of changes) {
    const timeMs = change.time * 1000;
    // Rows arrive newest-first, so the previous row is this change's newer
    // neighbour; a gap larger than `gapMs` between them is a lull.
    if (prevTimeMs !== null && prevTimeMs - timeMs > gapMs) flush();
    window.push(change);
    prevTimeMs = timeMs;
  }
  flush();

  return timeGroups;
}

// Build one group from a window of newest-first changes: dedupe the authors
// (newest contributor first) and aggregate the +/- counts.
function buildTimeGroup(windowNewestFirst: DraftChange[]): TimeGroup {
  const actors: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const c of windowNewestFirst) {
    if (!actors.includes(c.actor)) actors.push(c.actor);
    additions += c.additions;
    deletions += c.deletions;
  }
  const newest = windowNewestFirst[0];
  const oldest = windowNewestFirst[windowNewestFirst.length - 1];
  return {
    id: `tg-${newest.hash}`,
    endTime: newest.time,
    actors,
    additions,
    deletions,
    newest,
    oldest,
    changes: windowNewestFirst,
  };
}

// Build the checkpoint map for a scrub position. Each member's displayed
// version (`to`) is its heads as of `head`: the doc that owns that change is
// pinned exactly to it, every other member to its latest change at or before
// it (approximate but good enough). Each member's diff baseline (`from`) is
// its state just before `start` — the oldest change the scrubber spans — so
// the diff covers exactly the spanned changes: for the doc that owns `start`
// that's the change immediately before it (in causal order); for everyone
// else, their latest change strictly before `start`'s second (a change at
// exactly that second falls inside the span, so it belongs in the diff, not
// the baseline). A member with no change before `start` didn't exist yet, so
// `from` is `[]` (the whole doc reads as added). A null `start` means no
// diff: the baseline is the displayed heads themselves — set explicitly
// (rather than omitted) so a draft doesn't fall back to its fork-point
// baseline and light up the whole draft diff. Members with no change at or
// before `head` are omitted entirely: they didn't exist yet, so they fall
// through to live.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  head: ChangeRef,
  start: ChangeRef | null
): Promise<DraftCheckpoint> {
  const checkpoint: DraftCheckpoint = {};
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);

      // Displayed version: exactly the head change for the doc that owns it,
      // otherwise the member's latest change at or before it.
      let to: UrlHeads;
      if (member.url === head.docUrl) {
        // Pin the head's doc exactly even if it falls outside the metas
        // window (robust against a mismatched fork point).
        to = encodeHeads([head.hash]);
      } else {
        let pinnedIndex = -1;
        let bestTime = -Infinity;
        metas.forEach((m, i) => {
          if (m.time <= head.time && m.time >= bestTime) {
            bestTime = m.time;
            pinnedIndex = i;
          }
        });
        if (pinnedIndex < 0) continue;
        to = encodeHeads([metas[pinnedIndex].hash]);
      }

      // Baseline: the member's state just before `start`, or the displayed
      // heads themselves when the scrubber spans nothing.
      let from: UrlHeads;
      if (!start) {
        from = to;
      } else {
        let baseIndex = -1;
        if (member.url === start.docUrl) {
          baseIndex = metas.findIndex((m) => m.hash === start.hash) - 1;
        } else {
          let bestTime = -Infinity;
          metas.forEach((m, i) => {
            if (m.time < start.time && m.time >= bestTime) {
              bestTime = m.time;
              baseIndex = i;
            }
          });
        }
        const base = baseIndex >= 0 ? metas[baseIndex] : undefined;
        from = encodeHeads(base ? [base.hash] : []);
      }
      checkpoint[member.url] = { from, to };
    } catch (err) {
      console.warn(
        "[drafts] failed to compute checkpoint for member:",
        member,
        err
      );
    }
  }
  return checkpoint;
}

// Collect every member doc's post-fork changes into one interleaved timeline,
// newest first. `getChangesMetaSince` returns each doc's changes in topological
// (causal, oldest-first) order, so we stamp each change with its per-document
// `seq` index and sort by time with `seq` as the tie-break: `meta.time` is only
// second-resolution, so changes sharing a timestamp fall back to their
// document's own change order rather than being shuffled. On a draft `clonedAt`
// is set, so reading the clone since that fork point yields exactly the draft's
// own changes; on main both clone fields are null, so we read the original doc
// since `[]` for its full history. Members with no changes are omitted.
//
// Changes that predate the root document's creation are dropped: a member doc
// dragged in after the fact (e.g. a tldraw with its own prior edit history)
// would otherwise contribute changes from before this document even existed,
// which reads as noise. When the cutoff can't be resolved we keep everything.
async function collectInterleavedChanges(
  repo: Repo,
  members: DraftMemberDoc[],
  mainDocUrl: AutomergeUrl | undefined
): Promise<DraftChange[]> {
  const rows: DraftChange[] = [];
  const createdAt = await getDocCreationTime(repo, mainDocUrl);
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);
      if (metas.length === 0) continue;
      const title = await resolveDocTitle(doc, member.url);
      metas.forEach((meta, seq) => {
        // Hide anything from before the root document was created. `seq` still
        // reflects the change's true per-document position, so dropping rows
        // here doesn't disturb the tie-break ordering.
        if (createdAt !== undefined && meta.time && meta.time < createdAt) {
          return;
        }
        const { additions, deletions } = computeEditCounts(
          doc as Automerge.Doc<unknown>,
          meta.hash,
          meta.deps
        );
        rows.push({
          docUrl: member.url,
          title,
          hash: meta.hash,
          time: meta.time,
          actor: meta.actor,
          message: meta.message,
          seq,
          additions,
          deletions,
        });
      });
    } catch (err) {
      // A member doc that can't be resolved (or whose fork point is missing)
      // is simply omitted rather than failing the whole list.
      console.warn("[drafts] failed to read changes for member:", member, err);
    }
  }
  // Newest first by timestamp. On a tie (meta.time is only second-resolution),
  // fall back to each document's own change order, also newest-first: `seq` is
  // the per-document causal index (oldest = 0), so the higher (later) seq sorts
  // first. This keeps same-second changes consistent with the newest-first
  // intent instead of flipping that run to oldest-first.
  rows.sort((a, b) => b.time - a.time || b.seq - a.seq);
  return rows;
}

// Work out one change's rough edit magnitude by diffing it against its parents
// and counting its patches: splice lengths and insert counts as additions, del
// lengths as deletions, everything else (put / inc / mark / …) as one addition.
// `@patchwork` metadata paths are ignored. Feeds the group +/- counts.
function computeEditCounts(
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
async function getDocCreationTime(
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

// Resolve a document's display title: prefer its cached `@patchwork.title`,
// otherwise ask its datatype for one, falling back to a short url. Mirrors the
// sideboard's `docLinkFromUrl` but reuses an already-loaded doc.
async function resolveDocTitle(
  doc: unknown,
  url: AutomergeUrl
): Promise<string> {
  try {
    const meta = (doc as { "@patchwork"?: { title?: string; type?: string } })[
      "@patchwork"
    ];
    if (typeof meta?.title === "string" && meta.title) return meta.title;

    const type = meta?.type;
    if (type) {
      const registry = getRegistry("patchwork:datatype");
      const datatype = registry.get(type);
      if (datatype) {
        await registry.load(datatype.id);
        if (isLoadedPlugin(datatype)) {
          const title = datatype.module.getTitle(doc);
          if (title) return title;
        }
      }
    }
  } catch (err) {
    console.warn("[drafts] failed to resolve title for:", url, err);
  }
  return shortUrl(url);
}

// "automerge:4NMNnk…AVdXu" → a compact, fixed-width label for a doc url.
function shortUrl(url: AutomergeUrl): string {
  const id = url.replace(/^automerge:/, "");
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

// A stable-ish color for an author, so the same person reads the same across
// rows. Actors are Automerge actor ids (per device/session), the best "who"
// signal available in a draft's raw change history.
function authorColor(authorId: string): string {
  let hash = 0;
  for (let i = 0; i < authorId.length; i++) {
    hash = authorId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 63%)`;
}

// Two short characters to stand in for an author on their avatar.
function getInitials(authorId: string): string {
  return authorId.slice(0, 2).toUpperCase();
}

// Format an Automerge change time (Unix SECONDS) as a short local timestamp.
function formatTime(timeSeconds: number): string {
  if (!timeSeconds) return "";
  const date = new Date(timeSeconds * 1000);
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return `${datePart}, ${timePart}`;
}
