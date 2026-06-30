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

// A blank list to show until the provider sends the real one. (The Main card
// shows the document's own url, so the placeholder url here is never seen.)
const EMPTY_DRAFT_LIST: DraftList = {
  main: { url: "" as AutomergeUrl, members: [], childCount: 0 },
  drafts: [],
};

// Bump on each deploy to eyeball whether the latest build has synced.
const DRAFTS_VERSION = "0.0.5";

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

  // The list to draw — Main plus each draft and its documents — kept up to date
  // by the provider.
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
    log(
      url
        ? `checking out draft ${short(url)} (the overlay will remap docs to its clones)`
        : `checking out "main" (no overlay; you see the real docs)`
    );
    setSelectedEntry(null);
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
    entry: ClickedEntry
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    // Highlight the clicked row immediately, independent of the async checkpoint.
    setSelectedEntry({ docUrl: entry.docUrl, hash: entry.hash });
    log(
      `pinning ${draftUrl ? `draft ${short(draftUrl)}` : "main"} to a history ` +
        `entry on ${short(entry.docUrl)} — computing a frozen checkpoint across all members`
    );
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, entry);
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
        <div class="drafts-list">
          <MainCard
            hostDocUrl={hostDocHandle()?.url}
            isSelected={isMainSelected()}
            members={() => list().main.members}
            onSelect={() => selectDraft(null)}
            onSelectEntry={(entry) =>
              onSelectEntry(null, list().main.members, entry)
            }
            activeAnchor={() => (isMainSelected() ? selectedEntry() : null)}
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                members={summary.members}
                mainDocUrl={hostDocHandle()?.url}
                childCount={summary.childCount}
                isSelected={selected() === summary.url}
                onSelect={selectDraft}
                onSelectEntry={(entry) =>
                  onSelectEntry(summary.url, summary.members, entry)
                }
                activeAnchor={() =>
                  selected() === summary.url ? selectedEntry() : null
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
  onSelectEntry: (entry: ClickedEntry) => void;
  activeAnchor: Accessor<HighlightEntry | null>;
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
        activeAnchor={props.activeAnchor}
      />
    </div>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  members: DraftMemberDoc[];
  mainDocUrl: AutomergeUrl | undefined;
  childCount: number;
  isSelected: boolean;
  onSelect: (url: AutomergeUrl) => void;
  onSelectEntry: (entry: ClickedEntry) => void;
  activeAnchor: Accessor<HighlightEntry | null>;
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
        <div class="draft-card-url">{props.url}</div>
        <div class="draft-card-meta">
          {props.members.length} cloned doc(s) · {props.childCount} draft(s)
        </div>
      </button>
      <DraftChangesList
        members={() => props.members}
        mainDocUrl={props.mainDocUrl}
        onSelectEntry={props.onSelectEntry}
        activeAnchor={props.activeAnchor}
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
type DraftChange = {
  docUrl: AutomergeUrl;
  title: string;
  hash: string;
  time: number;
  actor: string;
  message: string | null;
  seq: number;
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
  onSelectEntry: (entry: ClickedEntry) => void;
  activeAnchor: Accessor<HighlightEntry | null>;
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

  return (
    <div class="draft-card-changes">
      <Show
        when={changes().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <For each={changes()}>
          {(change) => {
            // Highlight only the row you actually clicked, even though the
            // snapshot behind it freezes every document.
            const isActive = () => {
              const anchor = props.activeAnchor();
              return (
                !!anchor &&
                anchor.docUrl === change.docUrl &&
                anchor.hash === change.hash
              );
            };
            return (
              <button
                type="button"
                class="draft-change-row"
                data-selected={isActive() ? "" : undefined}
                title="View the draft at this point"
                onClick={() => {
                  log(
                    `history row clicked: "${change.title}" @ ${formatTime(change.time)} ` +
                      `on ${short(change.docUrl)}`,
                    change
                  );
                  props.onSelectEntry({
                    docUrl: change.docUrl,
                    hash: change.hash,
                    time: change.time,
                  });
                }}
              >
                <div class="draft-change-line">
                  <span class="draft-change-time">
                    {formatTime(change.time)}
                  </span>
                  <span class="draft-change-doc">{change.title}</span>
                  <Show when={change.message}>
                    <span class="draft-change-msg">{change.message}</span>
                  </Show>
                </div>
                <span class="draft-change-hash">
                  {encodeHeads([change.hash])[0]}
                </span>
              </button>
            );
          }}
        </For>
      </Show>
    </div>
  );
}

// Build the "this is how everything looked back then" snapshot for the row you
// clicked. The document you clicked is frozen to exactly that change; every
// other document is frozen to its latest change from around that same time
// (close enough). For each, we also note the change just before it, so we can
// highlight what that one change added — and if it's the document's very first
// change, there's nothing before it, so the whole doc shows as new. Documents
// that didn't exist yet at that time are left out and just show live.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  entry: ClickedEntry
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

      // Pick which change to freeze this document at: the exact one you clicked
      // (for that document), or otherwise its most recent change at or before
      // the clicked time.
      let pinnedIndex = -1;
      let to: UrlHeads;
      if (member.url === entry.docUrl) {
        pinnedIndex = metas.findIndex((m) => m.hash === entry.hash);
        // Freeze the clicked document at exactly that change, even if it's not
        // in the list we just gathered (just to be safe).
        to = encodeHeads([entry.hash]);
      } else {
        let bestTime = -Infinity;
        metas.forEach((m, i) => {
          if (m.time <= entry.time && m.time >= bestTime) {
            bestTime = m.time;
            pinnedIndex = i;
          }
        });
        if (pinnedIndex < 0) continue;
        to = encodeHeads([metas[pinnedIndex].hash]);
      }

      // The change right before the frozen one becomes the comparison point,
      // so we can show what the frozen change added.
      const prev = pinnedIndex >= 0 ? metas[pinnedIndex - 1] : undefined;
      const from = encodeHeads(prev ? [prev.hash] : []);
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
      const title = await resolveDocTitle(doc, member.url);
      metas.forEach((meta, seq) => {
        // Skip anything from before the project was created. (We still number
        // every change by its real position, so skipping rows here doesn't mess
        // up the ordering.)
        if (createdAt !== undefined && meta.time && meta.time < createdAt) {
          return;
        }
        rows.push({
          docUrl: member.url,
          title,
          hash: meta.hash,
          time: meta.time,
          actor: meta.actor,
          message: meta.message,
          seq,
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
