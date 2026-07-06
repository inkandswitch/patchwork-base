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
const DRAFTS_VERSION = "0.0.10";

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

  // Where the scrubber sits: the change whose heads are displayed. Ephemeral,
  // client-only state: the stored checkpoint (`checkedOut.at`) is what
  // actually pins the view; this mirrors it to render the token and the
  // group highlight. Not persisted, so it resets on reload (the pinned view
  // survives).
  const [scrubber, setScrubber] = createSignal<ScrubberState | null>(null);

  // A version being dragged out of a history timeline (from a group row or
  // the scrubber sticker). While set, the actions area shows a drop zone
  // that forks a new draft at that version; cleared on drop or dragend.
  const [dragVersion, setDragVersion] = createSignal<{
    members: DraftMemberDoc[];
    head: ChangeRef;
  } | null>(null);
  const [dropActive, setDropActive] = createSignal(false);

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
  // scrub head. The token and row highlight update immediately; the
  // checkpoint follows async. `draftUrl` is `null` for main.
  const onScrub = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    scrub: ScrubberState
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    setScrubber(scrub);
    const seq = ++scrubSeq;
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, scrub.head);
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

  // Fork a new top-level draft off a historical version: every member doc is
  // cloned at the heads it had as of `head` (the dragged-out change), not at
  // the live latest. Pre-populating `DraftDoc.clones` here means the overlay's
  // lazy `resolveClone` reuses these entries instead of forking at current
  // heads. Members with no changes at or before the version (created later)
  // are left out; the version's docs don't reference them yet, so they are
  // normally never resolved beneath the draft.
  const onCreateDraftFromVersion = async (
    members: DraftMemberDoc[],
    head: ChangeRef
  ) => {
    if (isFolder()) return;
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }

    // Reuse the scrub machinery to resolve per-doc heads at this version.
    const checkpoint = await computeCheckpoint(repo, members, head);

    const clones: Record<AutomergeUrl, CloneEntry> = {};
    for (const member of members) {
      const to = checkpoint[member.url]?.to;
      if (!to) continue;
      try {
        // Clone the doc the timeline read its changes from (the draft's clone
        // when dragging out of a draft), pinned to the version's heads —
        // repo.clone of a view-pinned handle clones the doc as of those heads.
        // Keyed by the original url so baselines and merge-back resolve.
        const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
        const clone = repo.clone(handle.view(to));
        clones[member.url] = { cloneUrl: clone.url, clonedAt: to };
      } catch (err) {
        console.warn(
          "[drafts] failed to fork member at version:",
          member.url,
          err
        );
      }
    }

    const mainDraft = await ensureMainDraft(repo, docHandle);
    const draft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parent: mainDraft.url,
      drafts: [],
      clones,
    });
    mainDraft.change((d) => {
      d.drafts.push(draft.url);
    });
    selectDraft(draft.url);
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
            onScrub={(scrub) => onScrub(null, list().main.members, scrub)}
            scrubber={() => (isMainSelected() ? scrubber() : null)}
            onDragVersion={(head) =>
              setDragVersion(
                head ? { members: list().main.members, head } : null
              )
            }
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                members={summary.members}
                mainDocUrl={hostDocHandle()?.url}
                isSelected={selected() === summary.url}
                onSelect={selectDraft}
                onScrub={(scrub) => onScrub(summary.url, summary.members, scrub)}
                scrubber={() =>
                  selected() === summary.url ? scrubber() : null
                }
                onDragVersion={(head) =>
                  setDragVersion(
                    head ? { members: summary.members, head } : null
                  )
                }
              />
            )}
          </For>
        </div>
        <div class="drafts-actions">
          <Show when={dragVersion()}>
            <div
              class="drafts-dropzone"
              data-over={dropActive() ? "" : undefined}
              onDragEnter={(e) => {
                e.preventDefault();
                setDropActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={() => setDropActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                const version = dragVersion();
                setDropActive(false);
                setDragVersion(null);
                if (version) {
                  void onCreateDraftFromVersion(version.members, version.head);
                }
              }}
            >
              Drop to fork a new draft from this version
            </div>
          </Show>
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
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
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
          onDragVersion={props.onDragVersion}
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
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
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
          onDragVersion={props.onDragVersion}
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
// non-expandable row. Clicking it parks the scrubber at `newest`.
type TimeGroup = {
  id: string;
  endTime: number;
  actors: string[];
  additions: number;
  deletions: number;
  newest: DraftChange;
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

// Where the scrubber sits: the change whose heads the view displays. The
// head is anchored by change identity rather than index so a recomputed
// timeline doesn't move the token.
type ScrubberState = {
  head: ChangeRef;
};

// Strip a timeline change down to the fields that identify it for scrubbing.
function changeRef(change: DraftChange): ChangeRef {
  return { docUrl: change.docUrl, hash: change.hash, time: change.time };
}

// Renders a draft's (or main's) changes as a timeline of activity groups:
// every member doc's changes interleaved newest first, then split wherever
// the editing paused for INACTIVITY_GAP (see `groupChanges`). A gutter on
// the left spans the whole history (top = latest change, bottom = first);
// the indicator — a calendar-style dot + line — marks the version being
// looked at. Its line paints *under* the (semi-transparent) group rows;
// dragging starts only from its handles in the gutter. While pinned, a
// sticker overlays the row at the head with the exact change the line sits
// on. The member set is passed in (from the card's `DraftSummary`); the
// effect below keeps the timeline live as those docs edit.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  mainDocUrl: AutomergeUrl | undefined;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
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

  // The flat, newest-first history folded into activity groups for rendering.
  const timeGroups = createMemo(() => groupChanges(changes()));

  // Scrub so the head sits at the timeline change at `headIndex` (global,
  // 0 = newest).
  const scrubTo = (headIndex: number) => {
    const head = changes()[headIndex];
    if (!head) return;
    props.onScrub({ head: changeRef(head) });
  };

  // Jump the scrubber to a group: head at the group's newest change.
  const scrubToGroup = (group: TimeGroup) => {
    props.onScrub({ head: changeRef(group.newest) });
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
  // across their group's band; an index past the oldest change maps to the
  // very bottom.
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

  // The indicator's pixel position: the head line's y in the track. The
  // zero-height box is fine — the dot and line overflow it and stay
  // grabbable. With nothing pinned it idles at the very top — you're looking
  // at the live latest.
  const tokenGeometry = createMemo(() => {
    if (changes().length === 0 || bands().length === 0) return null;
    return { top: yForIndex(headIndex() ?? 0) };
  });

  let trackEl: HTMLDivElement | undefined;

  // Pointer y relative to the track's top edge. The rect is re-read per event
  // so scrolling the card mid-drag stays accurate.
  const yInTrack = (ev: PointerEvent): number => {
    const rect = trackEl!.getBoundingClientRect();
    return ev.clientY - rect.top;
  };

  // Begin an indicator drag: the head follows the pointer (offset by where
  // the indicator was grabbed). Scrubbing starts only from the indicator's
  // own handles (dot, line) — the bare gutter and the rows don't scrub.
  // Every position snaps to an individual change, so the indicator can rest
  // anywhere in history — between groups or in the middle of one.
  const beginDrag = (ev: PointerEvent) => {
    if (!trackEl || changes().length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const grabOffset = yInTrack(ev) - yForIndex(headIndex() ?? 0);

    let last = headIndex() ?? 0;
    const onMove = (e: PointerEvent) => {
      const head = indexForY(yInTrack(e) - grabOffset);
      if (head === last) return;
      last = head;
      scrubTo(head);
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
  };

  // Start a native drag carrying a version out of the timeline. The payload
  // rides in a component signal (source and drop zone share the panel);
  // dataTransfer is only set so the browser actually starts the drag.
  const beginVersionDrag = (ev: DragEvent, head: ChangeRef) => {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.setData("text/plain", `${head.docUrl}#${head.hash}`);
    ev.dataTransfer.effectAllowed = "copy";
    props.onDragVersion(head);
  };

  // Zoomed-in scrubbing: group rows render 5x taller (see the data-zoomed
  // CSS), so the scrubber's per-change stops spread out for fine positioning.
  const [zoomed, setZoomed] = createSignal(false);
  // The scrollable changes area, needed to keep the head line fixed in
  // screen space across a zoom toggle.
  let scrollerEl: HTMLDivElement | undefined;

  // Toggle the zoom from `group`'s magnifier. Zooming in is entering scrubber
  // mode, so if nothing is pinned yet, pin to the group first (like clicking
  // the row). Rows then resize, so re-measure and shift the scroll position
  // to keep the head line where the eye already is.
  const toggleZoom = (group: TimeGroup) => {
    const turningOn = !zoomed();
    if (turningOn && headIndex() === null) scrubToGroup(group);
    const before = tokenGeometry()?.top ?? 0;
    const screenY = before - (scrollerEl?.scrollTop ?? 0);
    setZoomed(turningOn);
    requestAnimationFrame(() => {
      // The rows have re-laid out at the new size; bands re-measure on the
      // tick and the geometry memo re-evaluates on read.
      setMeasureTick((t) => t + 1);
      const after = tokenGeometry()?.top ?? 0;
      if (scrollerEl) scrollerEl.scrollTop = after - screenY;
    });
  };

  // The exact change the scrubber head sits on; feeds the sticker that
  // overlays the group row with the version being looked at. Zoomed out, it
  // is suppressed when the head sits exactly on a group's newest change (the
  // row already shows that version); zoomed in you are always in explicit
  // scrubber mode, so the sticker always shows.
  const headChange = createMemo<DraftChange | null>(() => {
    const idx = headIndex();
    const change = idx === null ? null : (changes()[idx] ?? null);
    if (!change) return null;
    const atGroupStart = timeGroups().some(
      (g) => g.newest.hash === change.hash && g.newest.docUrl === change.docUrl
    );
    return atGroupStart && !zoomed() ? null : change;
  });

  return (
    <div class="draft-card-changes" ref={scrollerEl}>
      <Show
        when={timeGroups().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <div
          class="draft-changes-body"
          data-zoomed={zoomed() ? "" : undefined}
        >
          <div class="draft-scrubber" ref={trackEl} />
          <div class="draft-changes-rows" ref={setRowsEl}>
            <For each={timeGroups()}>
              {(group) => (
                <TimeGroupRow
                  group={group}
                  rowRef={(el) => rowEls.set(group.id, el)}
                  isSelected={groupContainsHead(group)}
                  zoomActive={zoomed()}
                  onSelect={() => scrubToGroup(group)}
                  onToggleZoom={() => toggleZoom(group)}
                  onVersionDragStart={(e) =>
                    beginVersionDrag(e, changeRef(group.newest))
                  }
                  onVersionDragEnd={() => props.onDragVersion(null)}
                />
              )}
            </For>
          </div>
          <Show when={tokenGeometry()}>
            <div
              class="draft-scrubber-token"
              data-live={headIndex() === null ? "" : undefined}
              style={{ top: `${tokenGeometry()!.top}px` }}
            >
              {/* The head line, painted under the group rows. */}
              <div class="draft-scrubber-line" />
              {/* Grab handle, confined to the gutter. */}
              <div
                class="draft-scrubber-edge"
                title="Drag to scrub through history"
                onPointerDown={beginDrag}
              />
              <div
                class="draft-scrubber-dot"
                title="Drag to scrub through history"
                onPointerDown={beginDrag}
              />
              {/* Pinned inside a group: overlay the row with the exact
                  version the head sits on. Draggable — dragging it out forks
                  a new draft at that version. */}
              <Show when={headChange()}>
                {(change) => (
                  <div
                    class="draft-scrubber-sticker"
                    draggable={true}
                    title="Drag out to fork a new draft from this version"
                    onDragStart={(e) =>
                      beginVersionDrag(e, changeRef(change()))
                    }
                    onDragEnd={() => props.onDragVersion(null)}
                  >
                    <span class="draft-sticker-time">
                      {formatTime(change().time)}
                    </span>
                    <span class="draft-sticker-title">{change().title}</span>
                    <span class="draft-sticker-spacer" />
                    <EditCounts
                      additions={change().additions}
                      deletions={change().deletions}
                    />
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// One time group, rendered as a single non-expandable row: author avatars,
// the group's newest timestamp, the zoom toggle, and the aggregated +/-
// counts. Clicking the row parks the scrubber at the top of the group. The
// row highlights while the scrubber head sits inside the group. Dragging the
// row out forks a new draft at the group's newest change (the same version
// clicking pins); dragstart only fires past the movement threshold, so
// click-to-select is unaffected.
function TimeGroupRow(props: {
  group: TimeGroup;
  rowRef: (el: HTMLElement) => void;
  isSelected: boolean;
  zoomActive: boolean;
  onSelect: () => void;
  onToggleZoom: () => void;
  onVersionDragStart: (e: DragEvent) => void;
  onVersionDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      class="draft-group-row"
      ref={props.rowRef}
      data-selected={props.isSelected ? "" : undefined}
      title="View the draft as of this group — drag out to fork a draft from it"
      onClick={props.onSelect}
      draggable={true}
      onDragStart={props.onVersionDragStart}
      onDragEnd={props.onVersionDragEnd}
    >
      <AuthorAvatars actors={props.group.actors} />
      <span class="draft-group-time">{formatTime(props.group.endTime)}</span>
      <span
        class="draft-zoom-toggle"
        classList={{ "draft-zoom-toggle--active": props.zoomActive }}
        role="button"
        tabindex={0}
        title={
          props.zoomActive
            ? "Zoom back out"
            : "Zoom in for fine-grained scrubbing"
        }
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleZoom();
        }}
      >
        <MagnifierIcon />
      </span>
      <span class="draft-group-spacer" />
      <EditCounts
        additions={props.group.additions}
        deletions={props.group.deletions}
      />
    </button>
  );
}

// A magnifying glass for the zoom toggle shown on every group row. Zoomed
// in, group rows render 5x taller for fine-grained scrubbing.
function MagnifierIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
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
// changes stay in the same group while the pause between them is at most
// INACTIVITY_GAP; a longer lull starts a new group. A group can span any
// stretch of continuous editing — only inactivity splits it.
function groupChanges(changes: DraftChange[]): TimeGroup[] {
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
    // neighbour; a gap larger than the threshold between them is a lull.
    if (prevTimeMs !== null && prevTimeMs - timeMs > INACTIVITY_GAP) flush();
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
  return {
    id: `tg-${newest.hash}`,
    endTime: newest.time,
    actors,
    additions,
    deletions,
    newest,
    changes: windowNewestFirst,
  };
}

// Build the checkpoint map for a scrub position. Each member's displayed
// version (`to`) is its heads as of `head`: the doc that owns that change is
// pinned exactly to it, every other member to its latest change at or before
// it (approximate but good enough). The diff baseline (`from`) is always the
// displayed heads themselves (no diff) — set explicitly (rather than
// omitted) so a draft doesn't fall back to its fork-point baseline and light
// up the whole draft diff. Members with no change at or before `head` are
// omitted entirely: they didn't exist yet, so they fall through to live.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  head: ChangeRef
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

      checkpoint[member.url] = { from: to, to };
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
