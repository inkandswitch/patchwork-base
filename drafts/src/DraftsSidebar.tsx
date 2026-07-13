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
import { createDocSignal } from "solid-automerge";
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
  main: { url: "" as AutomergeUrl, members: [], childCount: 0, name: null },
  drafts: [],
};

// Bump on each deploy to eyeball whether the latest build has synced.
const DRAFTS_VERSION = "0.0.1";

export function DraftsSidebar(props: { element: HTMLElement }) {
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

  // Which single history row is highlighted. Ephemeral, client-only state: the
  // stored checkpoint (`checkedOut.at`) pins every member doc for the frozen
  // view, but we only ever highlight the one entry the user actually clicked.
  // Not persisted, so it resets on reload (the frozen view itself survives).
  const [selectedEntry, setSelectedEntry] =
    createSignal<HighlightEntry | null>(null);

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
    setSelectedEntry(null);
    handle.change((d) => {
      d.checkedOut = url;
      // Switching drafts (or to main) returns to the live latest heads.
      d.at = null;
    });
  };

  const getRepo = (): Repo | undefined =>
    "repo" in window ? window.repo : undefined;

  // Pin the checkout to a history entry: resolve every member doc's heads as of
  // the clicked entry's timestamp and store them alongside the selection, so the
  // frame renders that frozen, read-only view. `draftUrl` is `null` for main.
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
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, entry);
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

// One change in the interleaved timeline. `docUrl` is the original member url
// (used for labelling and as the checkpoint anchor), never the per-draft clone
// the change was read from. `title` is the source document's display title,
// shown as a per-row label. `seq` is the change's per-document causal index,
// used only to break timestamp ties (see `collectInterleavedChanges`).
type DraftChange = {
  docUrl: AutomergeUrl;
  title: string;
  hash: string;
  // Automerge change time, in SECONDS (multiply by 1000 for a JS Date).
  time: number;
  actor: string;
  message: string | null;
  seq: number;
};

// The timeline entry the user clicked, fed to `computeCheckpoint`. `time`
// anchors how the other docs' heads are resolved; it isn't stored in the
// resulting checkpoint.
type ClickedEntry = {
  docUrl: AutomergeUrl;
  hash: string;
  time: number;
};

// Identifies the single highlighted history row. Ephemeral UI state, not
// persisted — used only to render the one entry the user clicked as active.
type HighlightEntry = {
  docUrl: AutomergeUrl;
  hash: string;
};

// Renders a draft's (or main's) changes as a single timeline that interleaves
// every member doc's changes, newest first (see `collectInterleavedChanges`).
// The member set is passed in (from the card's `DraftSummary`); the effect
// below keeps the timeline live as those docs edit.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  mainDocUrl: AutomergeUrl | undefined;
  onSelectEntry: (entry: ClickedEntry) => void;
  activeAnchor: Accessor<HighlightEntry | null>;
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

  return (
    <div class="draft-card-changes">
      <Show
        when={changes().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <For each={changes()}>
          {(change) => {
            // Only the single entry the user clicked is highlighted, even
            // though the stored checkpoint pins one change per member doc.
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
                  console.log("[drafts] change clicked", change);
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

// Build the checkpoint map for the clicked history entry. The clicked doc is
// pinned exactly to that change (`to`); every other member to its latest change
// at or before the entry's timestamp (approximate but good enough). Each doc's
// `from` is the change immediately before its pinned one (in causal order), so a
// diff shows exactly what that entry introduced — the first change has no
// predecessor, so `from` is `[]` (the whole doc reads as added). Members with no
// change at or before that time are omitted: they didn't exist yet, so they fall
// through to live.
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
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);

      // Find the change to pin this doc to: exactly the clicked entry for that
      // doc, otherwise its latest change at or before the entry's time.
      let pinnedIndex = -1;
      let to: UrlHeads;
      if (member.url === entry.docUrl) {
        pinnedIndex = metas.findIndex((m) => m.hash === entry.hash);
        // Pin the clicked doc exactly even if it falls outside the metas window
        // (robust against a mismatched fork point).
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
