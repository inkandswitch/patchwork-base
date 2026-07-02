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
import { canonicalUrl } from "./clone-policy";

// A blank list to show until the provider sends the real one. (The Main card
// shows the document's own url, so the placeholder url here is never seen.)
const EMPTY_DRAFT_LIST: DraftList = {
  main: { url: "" as AutomergeUrl, members: [], childCount: 0 },
  drafts: [],
};

// Bump on each deploy to eyeball whether the latest build has synced.
const DRAFTS_VERSION = "0.0.8";

// Changes closer together in time than this fall in the same outer group ("made
// around the same time"). 15 min matches the history-view default window.
const TIME_WINDOW = 15 * 60 * 1000;

// How we decide two edits are in "the same area" of a document. An edit's
// location is read from its Automerge patch paths (see computeChangeArea);
// numeric path elements (character offsets, array indices) are bucketed by this
// size so nearby edits share an area while distant ones split apart. Bigger =
// coarser areas. Units are whatever the path index counts (characters for text).
const POSITION_BUCKET = 200;

// Console-logging helpers. Messages are prefixed `[drafts:ui]` — the sidebar,
// where user actions (create / select / merge a draft, pin a history entry)
// originate before the providers react to them.
const short = (url: string | null | undefined): string =>
  !url ? String(url) : url.replace(/^automerge:/, "").replace(/(.{6}).+(.{4})$/, "$1…$2");
const log = (msg: string, ...rest: unknown[]) =>
  console.log(`%c[drafts:ui]%c ${msg}`, "color:#16a34a;font-weight:bold", "", ...rest);

export function DraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = subscribeDoc<HasDrafts>(props.element, {
    type: "draft:root-doc",
  });

  // The little doc tracking what you have open (a draft, or Main).
  const [, checkedOutHandle] = subscribeDoc<CheckedOutDraft>(props.element, {
    type: "draft:checked-out",
  });

  // Read that doc straight from its handle. (A more "live" reactive read can
  // briefly show a value twice when it's written all at once; reading the handle
  // directly always gives the correct, finished document.)
  const checkedOut = createDocSignal(checkedOutHandle);
  const selected = createMemo<AutomergeUrl | null>(
    () => checkedOut()?.checkedOut ?? null
  );

  // Which single history row is highlighted. The frozen snapshot freezes every
  // document at once, but we only highlight the one row you actually clicked.
  // This is just visual state — it resets if you reload (the snapshot itself
  // sticks around).
  const [selectedEntry, setSelectedEntry] =
    createSignal<HighlightEntry | null>(null);

  // Whether the current pin is in "Highlight changes" mode: instead of freezing
  // the doc at the pinned moment, we leave it live and diff it against that
  // moment so the changes since then are highlighted. Just visual/session state.
  const [highlighting, setHighlighting] = createSignal(false);

  // The list to draw — Main plus each draft and its documents — kept up to date
  // by the provider.
  const list = subscribe<DraftList>(
    props.element,
    { type: "draft:list" },
    EMPTY_DRAFT_LIST
  );

  // A history row currently being dragged out to spawn a new draft. Holds which
  // card it came from (its documents and source draft, or null for Main) and the
  // exact change it was grabbed at. Null when nothing is being dragged.
  const [pendingDrag, setPendingDrag] = createSignal<{
    draftUrl: AutomergeUrl | null;
    members: DraftMemberDoc[];
    entry: ClickedEntry;
  } | null>(null);
  const beginDrag = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    entry: ClickedEntry
  ) => setPendingDrag({ draftUrl, members, entry });
  const endDrag = () => setPendingDrag(null);

  const isMainSelected = createMemo(() => selected() === null);
  // Drafting off a folder isn't supported yet, so creating a draft is disabled
  // while viewing a folder on Main.
  const isFolder = createMemo(
    () => hostDoc()?.["@patchwork"]?.type === "folder"
  );

  const selectDraft = (url: AutomergeUrl | null) => {
    const handle = checkedOutHandle();
    if (!handle) return;
    log(
      url
        ? `checking out draft ${short(url)} (the overlay will remap docs to its clones)`
        : `checking out "main" (no overlay; you see the real docs)`
    );
    setSelectedEntry(null);
    setHighlighting(false);
    handle.change((d) => {
      d.checkedOut = url;
      // Switching drafts (or to main) returns to the live latest heads.
      d.at = null;
    });
  };

  const getRepo = (): Repo | undefined =>
    "repo" in window ? window.repo : undefined;

  // You clicked a row in the change history: work out how every document looked
  // at that moment and save it, so the view freezes to that point in time.
  // `draftUrl` is null when you're on Main.
  const onSelectEntry = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    entry: ClickedEntry,
    highlight: boolean
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    // Highlight the clicked row immediately, independent of the async checkpoint.
    setSelectedEntry({ docUrl: entry.docUrl, hash: entry.hash });
    setHighlighting(highlight);
    log(
      `pinning ${draftUrl ? `draft ${short(draftUrl)}` : "main"} to a history ` +
        `entry on ${short(entry.docUrl)} — ${
          highlight
            ? "highlighting changes since then (live doc, diffed against that moment)"
            : "freezing every member at that moment"
        }`
    );
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, entry, highlight);
      log(
        `checkpoint computed for ${Object.keys(checkpoint).length} member doc(s)`,
        checkpoint
      );
      handle.change((d) => {
        d.checkedOut = draftUrl;
        d.at = checkpoint;
      });
    })();
  };

  // Stop viewing history and go back to the latest version, staying on the same
  // draft.
  const clearCheckpoint = () => {
    const handle = checkedOutHandle();
    if (!handle) return;
    log(`clearing the history pin — returning to the live latest heads`);
    setSelectedEntry(null);
    setHighlighting(false);
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

    // New drafts get added to the main draft's list. That bookkeeping record is
    // created the first time you ever draft this document.
    log(`creating a new draft off ${short(docHandle.url)}…`);
    const mainDraft = await ensureMainDraft(repo, docHandle);
    const draft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parent: mainDraft.url,
      drafts: [],
      clones: {},
    });
    log(
      `created draft ${short(draft.url)} (empty clones — docs fork lazily on first edit) ` +
        `and appended it to the main draft's .drafts`
    );
    mainDraft.change((d) => {
      d.drafts.push(draft.url);
    });
    selectDraft(draft.url);
  };

  // You dragged a history row onto the drop zone: spin up a new draft whose
  // documents are forked at exactly that point in time. The new draft branches
  // off whichever card the row came from (another draft, or Main).
  const onDropCreateDraft = async () => {
    const drag = pendingDrag();
    setPendingDrag(null);
    if (!drag) return;
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }
    log(
      `creating a new draft from a history point on ${short(drag.entry.docUrl)} ` +
        `@ ${formatTime(drag.entry.time)} (forking each doc at that moment)`
    );
    const mainDraft = await ensureMainDraft(repo, docHandle);
    const parentHandle = drag.draftUrl
      ? await repo.find<DraftDoc>(drag.draftUrl)
      : mainDraft;
    const draft = await createDraftFromCheckpoint(
      repo,
      parentHandle,
      drag.members,
      drag.entry
    );
    log(
      `created draft ${short(draft.url)} forked at the selected point ` +
        `(${Object.keys(draft.doc()?.clones ?? {}).length} doc(s)); switching to it`
    );
    selectDraft(draft.url);
  };

  // Get this document's main draft, creating it (and linking the document to it)
  // the first time. The main draft does no editing — it just holds the list of
  // drafts and a record of the document's own documents.
  const ensureMainDraft = async (
    repo: Repo,
    docHandle: DocHandle<HasDrafts>
  ): Promise<DocHandle<DraftDoc>> => {
    const existingUrl = docHandle.doc()?.["@patchwork"]?.mainDraftUrl;
    if (existingUrl) {
      log(`reusing this doc's existing main draft ${short(existingUrl)}`);
      return repo.find<DraftDoc>(existingUrl);
    }

    log(`first draft on this doc — creating its main draft (bookkeeping doc)`);
    const mainDraft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      isMain: true,
      parent: docHandle.url,
      drafts: [],
      clones: {},
    });
    docHandle.change((d) => {
      // Set the field directly rather than rebuilding the whole `@patchwork`
      // object — Automerge doesn't allow copying an existing object into itself.
      d["@patchwork"]!.mainDraftUrl = mainDraft.url;
    });
    return mainDraft;
  };

  // Save (or clear) a draft's display name. An empty name removes the field so
  // the card falls back to the generic "Draft" label.
  const onRenameDraft = async (url: AutomergeUrl, name: string) => {
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }
    const trimmed = name.trim();
    log(
      trimmed
        ? `renaming draft ${short(url)} → "${trimmed}"`
        : `clearing the name on draft ${short(url)}`
    );
    const handle = await repo.find<DraftDoc>(url);
    handle.change((d) => {
      if (trimmed) d.name = trimmed;
      else delete d.name;
    });
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
    log(`merging draft ${short(draftUrl)} back into main…`);
    const draftHandle = await repo.find<DraftDoc>(draftUrl);
    await mergeDraft(repo, draftHandle);
    log(`merge complete; draft marked merged. Switching back to main.`);
    selectDraft(null);
  };

  return (
    <div class="drafts-panel">
      <Show
        when={hostDoc()}
        fallback={<div class="drafts-empty">No document selected.</div>}
      >
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
        <div class="drafts-list">
          <MainCard
            hostDocUrl={hostDocHandle()?.url}
            isSelected={isMainSelected()}
            members={() => list().main.members}
            onSelect={() => selectDraft(null)}
            onSelectEntry={(entry, highlight) =>
              onSelectEntry(null, list().main.members, entry, highlight)
            }
            onEntryDragStart={(entry) =>
              beginDrag(null, list().main.members, entry)
            }
            onEntryDragEnd={endDrag}
            activeAnchor={() => (isMainSelected() ? selectedEntry() : null)}
            isHighlighting={() => (isMainSelected() ? highlighting() : false)}
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                name={summary.name}
                members={summary.members}
                mainDocUrl={hostDocHandle()?.url}
                childCount={summary.childCount}
                isSelected={selected() === summary.url}
                onSelect={selectDraft}
                onRename={(name) => onRenameDraft(summary.url, name)}
                onSelectEntry={(entry, highlight) =>
                  onSelectEntry(summary.url, summary.members, entry, highlight)
                }
                onEntryDragStart={(entry) =>
                  beginDrag(summary.url, summary.members, entry)
                }
                onEntryDragEnd={endDrag}
                activeAnchor={() =>
                  selected() === summary.url ? selectedEntry() : null
                }
                isHighlighting={() =>
                  selected() === summary.url ? highlighting() : false
                }
              />
            )}
          </For>
        </div>
        <Show when={pendingDrag()}>
          <div
            class="drafts-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => {
              e.preventDefault();
              void onDropCreateDraft();
            }}
          >
            Drop here to start a new draft from this point
          </div>
        </Show>
      </Show>
      <div class="drafts-version">v{DRAFTS_VERSION}</div>
    </div>
  );
}

// Apply a draft for real: merge each private copy back into its original
// document, note where each merge landed (for the record), and mark the draft
// as merged so it drops out of the sidebar.
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
    log(`  merging clone ${short(entry.cloneUrl)} → original ${short(originalUrl)}`);
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
  onSelectEntry: (entry: ClickedEntry, highlight: boolean) => void;
  onEntryDragStart: (entry: ClickedEntry) => void;
  onEntryDragEnd: () => void;
  activeAnchor: Accessor<HighlightEntry | null>;
  isHighlighting: Accessor<boolean>;
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
        <div class="draft-card-url">{props.hostDocUrl ?? ""}</div>
      </button>
      <DraftChangesList
        members={props.members}
        mainDocUrl={props.hostDocUrl}
        onSelectEntry={props.onSelectEntry}
        onEntryDragStart={props.onEntryDragStart}
        onEntryDragEnd={props.onEntryDragEnd}
        activeAnchor={props.activeAnchor}
        isHighlighting={props.isHighlighting}
      />
    </div>
  );
}

// A small pencil glyph for the rename affordance. Inherits color via
// `currentColor` and sizes to the surrounding font.
function PencilIcon() {
  return (
    <svg
      class="draft-card-pencil"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z" />
    </svg>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  name: string | undefined;
  members: DraftMemberDoc[];
  mainDocUrl: AutomergeUrl | undefined;
  childCount: number;
  isSelected: boolean;
  onSelect: (url: AutomergeUrl) => void;
  onRename: (name: string) => void;
  onSelectEntry: (entry: ClickedEntry, highlight: boolean) => void;
  onEntryDragStart: (entry: ClickedEntry) => void;
  onEntryDragEnd: () => void;
  activeAnchor: Accessor<HighlightEntry | null>;
  isHighlighting: Accessor<boolean>;
}) {
  // Inline rename state. `draftName` holds the in-progress edit; it's seeded
  // from the current name each time editing starts.
  const [editing, setEditing] = createSignal(false);
  const [draftName, setDraftName] = createSignal("");

  const startEditing = () => {
    setDraftName(props.name ?? "");
    setEditing(true);
  };
  const commit = () => {
    if (!editing()) return;
    setEditing(false);
    props.onRename(draftName());
  };
  const cancel = () => setEditing(false);

  return (
    <div class="draft-card" data-selected={props.isSelected ? "" : undefined}>
      {/* A div (not a button) so it can hold the rename input and pencil button
          without nesting interactive elements inside a button. */}
      <div
        class="draft-card-header"
        role="button"
        tabindex="0"
        title="Open draft"
        onClick={() => {
          if (!editing()) props.onSelect(props.url);
        }}
        onKeyDown={(e) => {
          if (editing()) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onSelect(props.url);
          }
        }}
      >
        <div class="draft-card-title">
          <Show
            when={editing()}
            fallback={
              <>
                <span class="draft-card-name">{props.name || "Draft"}</span>
                <button
                  type="button"
                  class="draft-card-rename"
                  title="Rename draft"
                  aria-label="Rename draft"
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditing();
                  }}
                >
                  <PencilIcon />
                </button>
                <Show when={props.isSelected}>
                  <span class="draft-badge">current</span>
                </Show>
              </>
            }
          >
            <input
              class="draft-card-name-input"
              value={draftName()}
              placeholder="Draft"
              ref={(el) => queueMicrotask(() => el.select())}
              onClick={(e) => e.stopPropagation()}
              onInput={(e) => setDraftName(e.currentTarget.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancel();
                }
              }}
            />
          </Show>
        </div>
        <div class="draft-card-url">{props.url}</div>
        <div class="draft-card-meta">
          {props.members.length} cloned doc(s) · {props.childCount} draft(s)
        </div>
      </div>
      <DraftChangesList
        members={() => props.members}
        mainDocUrl={props.mainDocUrl}
        onSelectEntry={props.onSelectEntry}
        onEntryDragStart={props.onEntryDragStart}
        onEntryDragEnd={props.onEntryDragEnd}
        activeAnchor={props.activeAnchor}
        isHighlighting={props.isHighlighting}
      />
    </div>
  );
}

// One row in the change history.
//   - docUrl:  which document this change belongs to (always the real document,
//              not the draft's private copy it was read from).
//   - title:   that document's name, shown on the row.
//   - hash:    the change's id.
//   - time:    when it happened (in seconds; ×1000 for a JS Date).
//   - actor:   who made it.
//   - message: an optional note attached to the change.
//   - seq:     where this change falls in its document's own order. Only used to
//              keep ordering sensible when two changes share the same second.
//   - area:    a datatype-agnostic key for "which part of the doc" this change
//              touched, derived from its Automerge patch paths (see
//              computeChangeArea). Changes to the same area by the same person
//              group together.
//   - areaLabel: a short human label for that area (e.g. "content", a shape id).
//   - additions/deletions: rough edit magnitude, used for the +/- bars.
//   - description: a compact summary of the actual edit, e.g. `+"e"` or `-"d"`,
//              shown on the individual-change rows.
type DraftChange = {
  docUrl: AutomergeUrl;
  title: string;
  hash: string;
  time: number;
  actor: string;
  message: string | null;
  seq: number;
  area: string;
  areaLabel: string;
  additions: number;
  deletions: number;
  description: string;
};

// An inner history group: consecutive-in-a-window changes made by the same
// person to the same area of one document. `changes` is kept oldest→newest so
// the drill-in scrubber can step through them in order.
type AreaGroup = {
  id: string;
  docUrl: AutomergeUrl;
  title: string;
  actor: string;
  areaLabel: string;
  additions: number;
  deletions: number;
  changes: DraftChange[];
};

// An outer history group: everything that happened around the same time,
// regardless of author, split inside into per-(author, area) AreaGroups.
type TimeGroup = {
  id: string;
  startTime: number;
  endTime: number;
  actors: string[];
  additions: number;
  deletions: number;
  areaGroups: AreaGroup[];
};

// The history row you clicked. Its `time` is used to line up the other
// documents to the same moment; it isn't stored in the resulting snapshot.
type ClickedEntry = {
  docUrl: AutomergeUrl;
  hash: string;
  time: number;
};

// Identifies the one history row currently highlighted. Just visual state, not
// saved.
type HighlightEntry = {
  docUrl: AutomergeUrl;
  hash: string;
};

// Shows a draft's (or Main's) changes as one combined history, mixing together
// every document's changes with the newest at the top. The list of documents is
// passed in; the effect below keeps the history updating as those docs are
// edited.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  mainDocUrl: AutomergeUrl | undefined;
  onSelectEntry: (entry: ClickedEntry, highlight: boolean) => void;
  onEntryDragStart: (entry: ClickedEntry) => void;
  onEntryDragEnd: () => void;
  activeAnchor: Accessor<HighlightEntry | null>;
  isHighlighting: Accessor<boolean>;
}) {
  const [changes, setChanges] = createSignal<DraftChange[]>([]);

  // Whenever the set of documents changes, load each one, listen for edits so
  // the history stays current, and rebuild it. The `disposed` flag stops a
  // late-arriving load from updating things after this was torn down.
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

  // The flat, newest-first history folded into the two-level tree the UI draws.
  const timeGroups = createMemo(() => groupChanges(changes()));

  return (
    <div class="draft-card-changes">
      <Show
        when={timeGroups().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <For each={timeGroups()}>
          {(group) => (
            <TimeGroupRow
              group={group}
              onSelectEntry={props.onSelectEntry}
              onEntryDragStart={props.onEntryDragStart}
              onEntryDragEnd={props.onEntryDragEnd}
              activeAnchor={props.activeAnchor}
              isHighlighting={props.isHighlighting}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

// Shared props threaded down to every level of the nested history so a click or
// drag anywhere resolves to the same pin/fork actions on the sidebar.
type HistoryRowActions = {
  onSelectEntry: (entry: ClickedEntry, highlight: boolean) => void;
  onEntryDragStart: (entry: ClickedEntry) => void;
  onEntryDragEnd: () => void;
  activeAnchor: Accessor<HighlightEntry | null>;
  // Whether the currently-pinned entry is in "Highlight changes" mode. Used to
  // reflect each row's checkbox state.
  isHighlighting: Accessor<boolean>;
};

// Is this change the one currently highlighted?
function anchorMatches(
  anchor: HighlightEntry | null,
  change: DraftChange
): boolean {
  return (
    !!anchor && anchor.docUrl === change.docUrl && anchor.hash === change.hash
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

// A little highlighter-marker glyph for the "Highlight changes" affordance.
function HighlighterIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2.5l4 4-6 6H4.5l-1-1v-2z" />
      <path d="M2.5 14.5h5" />
    </svg>
  );
}

// The "Highlight changes" toggle shown on any history item. It pins the moment
// this item represents and, when on, diffs the live doc against that moment so
// the changes since then are highlighted. Only visible on hover of its row
// (see CSS) unless it's the active one. `entry` is the moment to pin (a group's
// newest change, or an individual change).
function HighlightToggle(props: {
  entry: ClickedEntry;
  active: boolean;
  onSelectEntry: (entry: ClickedEntry, highlight: boolean) => void;
}) {
  return (
    <button
      type="button"
      class="draft-highlight-toggle"
      data-active={props.active ? "" : undefined}
      title="Highlight what changed between now and this moment"
      aria-label="Highlight changes"
      aria-pressed={props.active}
      onClick={(e) => {
        e.stopPropagation();
        props.onSelectEntry(props.entry, !props.active);
      }}
    >
      <HighlighterIcon />
    </button>
  );
}

// The moment a whole time group represents: its most recent change.
function timeGroupNewest(group: TimeGroup): DraftChange {
  let best: DraftChange | null = null;
  for (const ag of group.areaGroups) {
    const c = ag.changes[ag.changes.length - 1];
    if (!best || c.time > best.time) best = c;
  }
  return best!;
}

// Turn a change into the {docUrl, hash, time} moment used for pinning.
function toEntry(change: DraftChange): ClickedEntry {
  return { docUrl: change.docUrl, hash: change.hash, time: change.time };
}

// The +N / -N edit-size bars shared by both group levels.
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

// One outer group: "changes made around the same time". Expands to reveal its
// per-(author, area) inner groups.
function TimeGroupRow(props: { group: TimeGroup } & HistoryRowActions) {
  const newest = () => timeGroupNewest(props.group);
  const containsActive = () =>
    props.group.areaGroups.some((ag) =>
      ag.changes.some((c) => anchorMatches(props.activeAnchor(), c))
    );
  // The group's highlight toggle is "on" when its newest change is the pinned
  // one and we're in highlight mode.
  const highlightActive = () =>
    anchorMatches(props.activeAnchor(), newest()) && props.isHighlighting();
  const [open, setOpen] = createSignal(false);
  // Auto-open the group that holds the pinned change so it's never hidden.
  createEffect(() => {
    if (containsActive()) setOpen(true);
  });

  return (
    <div class="draft-timegroup">
      {/* A div (not a button) so the highlight toggle button can nest inside
          without invalid button-in-button markup. */}
      <div
        class="draft-group-row"
        role="button"
        tabindex="0"
        data-open={open() ? "" : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        title={open() ? "Collapse" : "Expand"}
      >
        <span class="draft-caret">{open() ? "▾" : "▸"}</span>
        <AuthorAvatars actors={props.group.actors} />
        <span class="draft-group-time">{formatTime(props.group.endTime)}</span>
        <span class="draft-group-spacer" />
        <EditCounts
          additions={props.group.additions}
          deletions={props.group.deletions}
        />
        <HighlightToggle
          entry={toEntry(newest())}
          active={highlightActive()}
          onSelectEntry={props.onSelectEntry}
        />
      </div>
      <Show when={open()}>
        <div class="draft-areagroups">
          <For each={props.group.areaGroups}>
            {(areaGroup) => (
              <AreaGroupRow
                group={areaGroup}
                onSelectEntry={props.onSelectEntry}
                onEntryDragStart={props.onEntryDragStart}
                onEntryDragEnd={props.onEntryDragEnd}
                activeAnchor={props.activeAnchor}
                isHighlighting={props.isHighlighting}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// One inner group: the same person's edits to the same area. Clicking expands
// it to reveal the individual changes underneath.
function AreaGroupRow(props: { group: AreaGroup } & HistoryRowActions) {
  const newest = () => props.group.changes[props.group.changes.length - 1];
  const containsActive = () =>
    props.group.changes.some((c) => anchorMatches(props.activeAnchor(), c));
  const highlightActive = () =>
    anchorMatches(props.activeAnchor(), newest()) && props.isHighlighting();
  const [open, setOpen] = createSignal(false);
  createEffect(() => {
    if (containsActive()) setOpen(true);
  });

  return (
    <div class="draft-areagroup">
      {/* A div (not a button) so the highlight toggle button can nest inside. */}
      <div
        class="draft-area-row"
        role="button"
        tabindex="0"
        draggable={true}
        data-open={open() ? "" : undefined}
        data-selected={containsActive() ? "" : undefined}
        title="Click to expand · drag out to start a new draft from here"
        onDragStart={(e) => {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "copy";
            e.dataTransfer.setData(
              "text/plain",
              encodeHeads([newest().hash])[0]
            );
          }
          props.onEntryDragStart(toEntry(newest()));
        }}
        onDragEnd={() => props.onEntryDragEnd()}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span class="draft-caret">{open() ? "▾" : "▸"}</span>
        <div
          class="draft-avatar"
          title={props.group.actor}
          style={{ background: authorColor(props.group.actor) }}
        >
          {getInitials(props.group.actor)}
        </div>
        <span class="draft-area-doc">{props.group.title}</span>
        <span class="draft-area-label">{props.group.areaLabel}</span>
        <span class="draft-group-spacer" />
        <EditCounts
          additions={props.group.additions}
          deletions={props.group.deletions}
        />
        <HighlightToggle
          entry={toEntry(newest())}
          active={highlightActive()}
          onSelectEntry={props.onSelectEntry}
        />
      </div>
      <Show when={open()}>
        <div class="draft-changelist">
          {/* Newest change first, to match the rest of the history. */}
          <For each={[...props.group.changes].reverse()}>
            {(change) => (
              <ChangeRow
                change={change}
                onSelectEntry={props.onSelectEntry}
                onEntryDragStart={props.onEntryDragStart}
                onEntryDragEnd={props.onEntryDragEnd}
                activeAnchor={props.activeAnchor}
                isHighlighting={props.isHighlighting}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// One individual change — the finest grain. Clicking pins the doc *at* this
// change (time-travel, no diff). The "Highlight changes" checkbox instead pins
// the live doc diffed against this moment, so the changes since then show up.
function ChangeRow(props: { change: DraftChange } & HistoryRowActions) {
  const isActive = () => anchorMatches(props.activeAnchor(), props.change);
  const highlightActive = () => isActive() && props.isHighlighting();
  const entry = () => toEntry(props.change);

  return (
    <div class="draft-change-item" data-selected={isActive() ? "" : undefined}>
      <button
        type="button"
        class="draft-change-pin"
        draggable={true}
        title="Click to view the doc at this change · drag out to start a new draft from here"
        onDragStart={(e) => {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "copy";
            e.dataTransfer.setData(
              "text/plain",
              encodeHeads([props.change.hash])[0]
            );
          }
          props.onEntryDragStart(entry());
        }}
        onDragEnd={() => props.onEntryDragEnd()}
        onClick={() => props.onSelectEntry(entry(), false)}
      >
        <span class="draft-change-time">{formatTime(props.change.time)}</span>
        <span class="draft-change-desc">{props.change.description}</span>
      </button>
      <HighlightToggle
        entry={entry()}
        active={highlightActive()}
        onSelectEntry={props.onSelectEntry}
      />
    </div>
  );
}

// Create a brand-new draft seeded from a point in history. For every document
// that existed at that moment, fork a private copy frozen at exactly that
// version (via the same checkpoint logic used for time-travel viewing) and
// record it as the draft's starting clone — so the new draft opens as an
// editable continuation of that past state. Documents that didn't exist yet are
// simply left out; they'll fork lazily from their live version on first edit.
// The new draft is appended to `parentHandle`'s list of children.
async function createDraftFromCheckpoint(
  repo: Repo,
  parentHandle: DocHandle<DraftDoc>,
  members: DraftMemberDoc[],
  entry: ClickedEntry
): Promise<DocHandle<DraftDoc>> {
  // Plain mode: we need each member's `to` heads to fork the new draft from.
  const checkpoint = await computeCheckpoint(repo, members, entry, false);
  const clones: Record<AutomergeUrl, CloneEntry> = {};
  for (const member of members) {
    const to = checkpoint[member.url]?.to;
    if (!to) continue;
    try {
      // Read from the member's current backing doc (the source card's clone if
      // it has one, otherwise the real doc), then fork it at the pinned version.
      const sourceHandle = await repo.find<unknown>(
        member.cloneUrl ?? member.url
      );
      const viewHandle = sourceHandle.view(to);
      const cloneHandle = repo.clone(viewHandle);
      clones[member.url] = {
        cloneUrl: canonicalUrl(cloneHandle.url),
        clonedAt: to,
      };
    } catch (err) {
      console.warn(
        "[drafts] failed to fork member at checkpoint:",
        member,
        err
      );
    }
  }
  const draft = repo.create<DraftDoc>({
    "@patchwork": { type: "draft" },
    parent: parentHandle.url,
    drafts: [],
    clones,
  });
  parentHandle.change((d) => {
    d.drafts.push(draft.url);
  });
  return draft;
}

// Build the snapshot for the moment you clicked, in one of two modes:
//
//   - Plain (highlight = false): freeze every document *at* that moment
//     (checkpoint `to`). The doc you clicked freezes at exactly that change;
//     every other doc freezes at its most recent change from around that time.
//     No `from`, so nothing is diff-highlighted — you just see the past state.
//
//   - Highlight (highlight = true): leave every document live (no `to`) and set
//     `from` to that moment, so the editor diffs the current doc against then
//     and highlights everything that changed since. This is the "diff between
//     now and this moment" view.
//
// Documents that didn't exist yet at that time are left out and just show live.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  entry: ClickedEntry,
  highlight: boolean
): Promise<DraftCheckpoint> {
  const checkpoint: DraftCheckpoint = {};
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      // Look at this document's changes since the draft copied it (or its whole
      // history on Main).
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);

      // Pick which change represents this moment for this document: the exact
      // one you clicked (for that document), or otherwise its most recent change
      // at or before the clicked time.
      let momentHeads: UrlHeads;
      if (member.url === entry.docUrl) {
        momentHeads = encodeHeads([entry.hash]);
      } else {
        let pinnedIndex = -1;
        let bestTime = -Infinity;
        metas.forEach((m, i) => {
          if (m.time <= entry.time && m.time >= bestTime) {
            bestTime = m.time;
            pinnedIndex = i;
          }
        });
        if (pinnedIndex < 0) continue;
        momentHeads = encodeHeads([metas[pinnedIndex].hash]);
      }

      checkpoint[member.url] = highlight
        ? // Live doc, diffed against the moment → highlight changes since then.
          { from: momentHeads }
        : // Frozen at the moment, no baseline → plain time-travel, no diff.
          { to: momentHeads };
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

// Gather every document's changes into one combined history, newest first. In a
// draft we only show the changes the draft itself made (everything since it
// copied each document); on Main we show each document's full history. Each
// change is tagged with its position in its own document so that changes sharing
// the same second (timestamps are only second-accurate) stay in a sensible
// order instead of getting shuffled. Documents with no changes are skipped.
//
// Changes from before this whole project was created are hidden: a document
// added later (say a drawing that already had its own edit history) would
// otherwise show changes from before the project existed, which is just noise.
// If we can't work out that cutoff, we keep everything.
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
      // The doc's live title, used as the row label and as the fallback for
      // changes from before a name was set.
      const liveTitle = await resolveDocTitle(doc, member.url);
      // Renaming writes `@patchwork.title`. Only when the doc carries such a
      // field do we bother reading the title per-change (so a rename doesn't
      // retroactively relabel older rows). Datatype/url-derived titles stay on
      // the single `liveTitle` — looking those up per change would be the slow
      // path we want to avoid.
      const titled = !!titleField(doc);
      metas.forEach((meta, seq) => {
        // Skip anything from before the project was created. (We still number
        // every change by its real position, so skipping rows here doesn't mess
        // up the ordering.)
        if (createdAt !== undefined && meta.time && meta.time < createdAt) {
          return;
        }
        // Work out which part of the doc this change touched (and how big it
        // was) from its patches, so we can group by area, show +/- bars, and
        // describe the individual edit (e.g. `+"e"`).
        const { area, areaLabel, additions, deletions, description } =
          computeChangeInfo(doc, meta.hash, meta.deps, member.url);
        rows.push({
          docUrl: member.url,
          // `Automerge.view` is a cheap, copy-free immutable snapshot; reading
          // one string field off it per change is inexpensive.
          title: titled ? titleAtChange(doc, meta.hash, liveTitle) : liveTitle,
          hash: meta.hash,
          time: meta.time,
          actor: meta.actor,
          message: meta.message,
          seq,
          area,
          areaLabel,
          additions,
          deletions,
          description,
        });
      });
    } catch (err) {
      // If one document can't be read, just leave it out rather than breaking
      // the whole history.
      console.warn("[drafts] failed to read changes for member:", member, err);
    }
  }
  // Sort newest first. When two changes share the same second, fall back to
  // their order within their own document (later one first) so same-second
  // changes still read newest-to-oldest.
  rows.sort((a, b) => b.time - a.time || b.seq - a.seq);
  return rows;
}

// Read a document's `@patchwork.title` field, if any. Used to decide whether a
// doc is named via a stored title (so we should track it per-change) versus a
// datatype/url-derived name (which we leave constant for speed).
function titleField(doc: unknown): string | undefined {
  const title = (doc as { "@patchwork"?: { title?: unknown } })["@patchwork"]
    ?.title;
  return typeof title === "string" ? title : undefined;
}

// The document's title as of one specific change. Uses `Automerge.view` — a
// cheap, copy-free immutable view at those heads — and reads the stored title
// field straight off it. Falls back to `fallback` for changes from before the
// title was set (or if the view can't be taken).
function titleAtChange(
  doc: unknown,
  hash: string,
  fallback: string
): string {
  try {
    const view = Automerge.view(
      doc as Automerge.Doc<unknown>,
      [hash] as unknown as Automerge.Heads
    );
    return titleField(view) ?? fallback;
  } catch {
    return fallback;
  }
}

// When was a document created? Reads its history and returns the time of its
// very first change (in seconds). Returns undefined if that can't be figured
// out, in which case callers don't hide anything.
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

// Work out a document's display name: use its saved title if it has one,
// otherwise ask its type how to name it, and fall back to a shortened url.
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

// Work out which part of a document one change touched, plus a rough size, by
// diffing the change against its parents and reading the patch paths. This is
// deliberately datatype-agnostic: every Automerge patch carries a `path` (e.g.
// ["content", 45] for text, ["store", "shape:abc", "x"] for a drawing), so we
// build an "area token" from that path and let the caller group edits sharing a
// token. Numeric path elements (character offsets, list indices) are bucketed by
// POSITION_BUCKET so nearby edits collapse into one area while distant ones
// split. `@patchwork` metadata paths are ignored. The primary area is the token
// hit by the most patches; area is prefixed with the doc url so the same path in
// two different docs stays distinct.
function computeChangeInfo(
  doc: Automerge.Doc<unknown>,
  hash: string,
  deps: string[],
  memberUrl: AutomergeUrl
): {
  area: string;
  areaLabel: string;
  additions: number;
  deletions: number;
  description: string;
} {
  let additions = 0;
  let deletions = 0;
  const tokenCounts = new Map<string, number>();
  const tokenLabels = new Map<string, string>();

  // Collected for the human-readable description, e.g. `+"e"` / `-"d"`.
  let insertedText = "";
  let deletedText = "";
  let deletedCount = 0;
  let otherTouches = 0;
  // A view of the doc *before* this change, taken lazily so we can recover the
  // text a deletion removed (patches carry a length, not the removed content).
  let beforeView: Automerge.Doc<unknown> | null = null;

  try {
    const patches = Automerge.diff(
      doc,
      deps as unknown as Automerge.Heads,
      [hash] as unknown as Automerge.Heads
    );
    for (const patch of patches) {
      const path = patch.path;
      if (path[0] === "@patchwork") continue;

      if (patch.action === "splice") {
        const value = patch.value as string;
        additions += value.length;
        insertedText += value;
      } else if (patch.action === "insert") {
        additions += Array.isArray((patch as { values?: unknown[] }).values)
          ? (patch as { values: unknown[] }).values.length
          : 1;
        otherTouches += 1;
      } else if (patch.action === "del") {
        const len = (patch as { length?: number }).length ?? 1;
        deletions += len;
        deletedCount += len;
        // Try to recover what was removed by reading the pre-change value at
        // this path. Works for text (a string container + index); anything
        // else just falls back to the count.
        try {
          if (!beforeView) {
            beforeView = Automerge.view(
              doc,
              deps as unknown as Automerge.Heads
            );
          }
          const container = valueAtPath(beforeView, path.slice(0, -1));
          const idx = path[path.length - 1];
          if (typeof container === "string" && typeof idx === "number") {
            deletedText += container.slice(idx, idx + len);
          }
        } catch {
          /* fall back to the count */
        }
      } else {
        // put / inc / mark / etc. — count as a single touch.
        additions += 1;
        otherTouches += 1;
      }

      const token = path
        .map((el) =>
          typeof el === "number" ? `~${Math.floor(el / POSITION_BUCKET)}` : el
        )
        .join("/");
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      if (!tokenLabels.has(token)) {
        const lastString = [...path]
          .reverse()
          .find((el) => typeof el === "string") as string | undefined;
        tokenLabels.set(token, lastString ?? token);
      }
    }
  } catch (err) {
    console.warn("[drafts] failed to diff change for area:", hash, err);
  }

  // Primary area = the token touched by the most patches (Map preserves
  // first-appearance order, which breaks ties toward the earliest patch).
  let primary = "";
  let best = -1;
  for (const [token, count] of tokenCounts) {
    if (count > best) {
      best = count;
      primary = token;
    }
  }
  if (!primary) {
    // Metadata-only or empty change: bucket everything together.
    primary = "other";
    tokenLabels.set("other", "other");
  }

  // Assemble the compact edit description.
  const parts: string[] = [];
  if (insertedText) parts.push(`+${quoteSnippet(insertedText)}`);
  if (deletedText) parts.push(`-${quoteSnippet(deletedText)}`);
  else if (deletedCount) parts.push(`-${deletedCount}`);
  if (parts.length === 0 && otherTouches > 0) {
    parts.push(otherTouches === 1 ? "edit" : `${otherTouches} edits`);
  }
  const description = parts.join(" ") || "edit";

  return {
    area: `${memberUrl}::${primary}`,
    areaLabel: shortenAreaLabel(tokenLabels.get(primary) ?? primary),
    additions,
    deletions,
    description,
  };
}

// Follow a patch path (a sequence of keys/indices) into a doc/view and return
// whatever value sits there. Used to read the text a deletion removed.
function valueAtPath(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

// Render a bit of edited text for a change description: collapse whitespace,
// truncate, and wrap in quotes — e.g. `"the quick brown…"`.
function quoteSnippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  const trimmed =
    oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine;
  return `"${trimmed}"`;
}

// Trim long, id-like area labels (e.g. "shape:abcdef123456") to something that
// fits a row, keeping the meaningful prefix.
function shortenAreaLabel(label: string): string {
  if (label.length > 16 && label.includes(":")) {
    const idx = label.indexOf(":");
    return `${label.slice(0, idx)}:${label.slice(idx + 1, idx + 5)}…`;
  }
  return label;
}

// Fold a flat, newest-first list of changes into the two-level history:
// outer groups by time window (any author), each split into inner groups by
// (author + area). Inner-group changes are ordered oldest→newest for scrubbing.
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
    if (prevTimeMs !== null && Math.abs(prevTimeMs - timeMs) > TIME_WINDOW) {
      flush();
    }
    window.push(change);
    prevTimeMs = timeMs;
  }
  flush();

  return timeGroups;
}

// Build one outer group from a window of newest-first changes: bucket them by
// (author, area) into inner groups and aggregate stats.
function buildTimeGroup(windowNewestFirst: DraftChange[]): TimeGroup {
  const buckets = new Map<string, DraftChange[]>();
  for (const c of windowNewestFirst) {
    const key = `${c.actor}|${c.area}`;
    const arr = buckets.get(key);
    if (arr) arr.push(c);
    else buckets.set(key, [c]);
  }

  const actors: string[] = [];
  const areaGroups: AreaGroup[] = [];
  let additions = 0;
  let deletions = 0;

  for (const [key, bucketNewestFirst] of buckets) {
    const actor = bucketNewestFirst[0].actor;
    if (!actors.includes(actor)) actors.push(actor);
    // Oldest→newest so the scrubber reads left (earliest) to right (latest).
    const chrono = [...bucketNewestFirst].reverse();
    let add = 0;
    let del = 0;
    for (const c of chrono) {
      add += c.additions;
      del += c.deletions;
    }
    additions += add;
    deletions += del;
    const newest = chrono[chrono.length - 1];
    areaGroups.push({
      id: `${key}|${newest.hash}`,
      docUrl: newest.docUrl,
      title: newest.title,
      actor,
      areaLabel: newest.areaLabel,
      additions: add,
      deletions: del,
      changes: chrono,
    });
  }

  const times = windowNewestFirst.map((c) => c.time);
  const startTime = Math.min(...times);
  const endTime = Math.max(...times);
  return {
    id: `tg-${startTime}-${endTime}-${windowNewestFirst[0].hash}`,
    startTime,
    endTime,
    actors,
    additions,
    deletions,
    areaGroups,
  };
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

// A friendly magnitude label from edit counts, e.g. "Minor addition".
function magnitudeLabel(additions: number, deletions: number): string {
  const total = additions + deletions;
  if (total === 0) return "No change";
  const kind = additions >= deletions ? "addition" : "deletion";
  const size = total < 50 ? "Minor" : total < 500 ? "Medium" : "Large";
  return `${size} ${kind}`;
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
