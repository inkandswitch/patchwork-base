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
    anchor: DraftCheckpoint["anchor"]
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, anchor);
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
            onSelectEntry={(anchor) =>
              onSelectEntry(null, list().main.members, anchor)
            }
            activeAnchor={() =>
              isMainSelected() ? (checkedOut()?.at?.anchor ?? null) : null
            }
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                members={summary.members}
                childCount={summary.childCount}
                isSelected={selected() === summary.url}
                onSelect={selectDraft}
                onSelectEntry={(anchor) =>
                  onSelectEntry(summary.url, summary.members, anchor)
                }
                activeAnchor={() =>
                  selected() === summary.url
                    ? (checkedOut()?.at?.anchor ?? null)
                    : null
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
  onSelectEntry: (anchor: DraftCheckpoint["anchor"]) => void;
  activeAnchor: Accessor<DraftCheckpoint["anchor"] | null>;
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
        onSelectEntry={props.onSelectEntry}
        activeAnchor={props.activeAnchor}
      />
    </div>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  members: DraftMemberDoc[];
  childCount: number;
  isSelected: boolean;
  onSelect: (url: AutomergeUrl) => void;
  onSelectEntry: (anchor: DraftCheckpoint["anchor"]) => void;
  activeAnchor: Accessor<DraftCheckpoint["anchor"] | null>;
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
        onSelectEntry={props.onSelectEntry}
        activeAnchor={props.activeAnchor}
      />
    </div>
  );
}

// One change in a document's history. `docUrl` is the original member url (used
// for labelling and as the checkpoint anchor), never the per-draft clone the
// change was read from.
type DraftChange = {
  docUrl: AutomergeUrl;
  hash: string;
  // Automerge change time, in SECONDS (multiply by 1000 for a JS Date).
  time: number;
  actor: string;
  message: string | null;
};

// A member document's changes, newest first. The card lists one of these per
// member rather than interleaving every doc's changes into one timeline.
type DraftChangeGroup = {
  docUrl: AutomergeUrl;
  changes: DraftChange[];
};

// Renders a draft's (or main's) changes grouped per member document, each
// group newest first. The member set is passed in (from the card's
// `DraftSummary`); the effect below keeps the groups live as those docs edit.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  onSelectEntry: (anchor: DraftCheckpoint["anchor"]) => void;
  activeAnchor: Accessor<DraftCheckpoint["anchor"] | null>;
}) {
  const [groups, setGroups] = createSignal<DraftChangeGroup[]>([]);

  // Whenever the member set changes, resolve a handle per member, listen for
  // edits so the groups stay live, and recompute. A `disposed` flag guards
  // against the async resolution landing after the effect was torn down.
  createEffect(() => {
    const list = props.members();
    const repo = "repo" in window ? window.repo : undefined;
    if (!repo) return;

    let disposed = false;
    const listeners: { handle: DocHandle<unknown>; onChange: () => void }[] =
      [];

    const recompute = async () => {
      const next = await collectChangesByDocument(repo, list);
      if (!disposed) setGroups(next);
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
        when={groups().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <For each={groups()}>
          {(group) => (
            <div class="draft-change-group">
              <div class="draft-change-group-header">
                {shortUrl(group.docUrl)}
              </div>
              <For each={group.changes}>
                {(change) => {
                  const isActive = () => {
                    const a = props.activeAnchor();
                    return (
                      !!a && a.docUrl === change.docUrl && a.hash === change.hash
                    );
                  };
                  return (
                    <button
                      type="button"
                      class="draft-change-row"
                      data-selected={isActive() ? "" : undefined}
                      title="View the draft at this point"
                      onClick={() =>
                        props.onSelectEntry({
                          docUrl: change.docUrl,
                          hash: change.hash,
                          time: change.time,
                        })
                      }
                    >
                      <span class="draft-change-time">
                        {formatTime(change.time)}
                      </span>
                      <Show when={change.message}>
                        <span class="draft-change-msg">{change.message}</span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// Resolve the per-document heads to view a draft (or main) at the clicked
// history entry. The anchor doc is pinned exactly to the clicked change; every
// other member is pinned to its latest change at or before the anchor's
// timestamp (approximate but good enough). Members with no change at or before
// that time are omitted — they didn't exist yet, so they fall through to live.
//
// `baselineHeads` records the change immediately before each pinned one (in
// causal order), so a checkpoint diff shows exactly what that entry introduced.
// On main the draft-list provider serves this as `draft:baseline`; on a draft
// the overlay's fork-point baseline wins, so this goes unused there.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  anchor: DraftCheckpoint["anchor"]
): Promise<DraftCheckpoint> {
  const heads: Record<AutomergeUrl, UrlHeads> = {};
  const baselineHeads: Record<AutomergeUrl, UrlHeads> = {};
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);

      // Find the change to pin this doc to: exactly the clicked entry for the
      // anchor doc, otherwise its latest change at or before the anchor's time.
      let pinnedIndex = -1;
      if (member.url === anchor.docUrl) {
        pinnedIndex = metas.findIndex((m) => m.hash === anchor.hash);
        // Pin the anchor exactly even if it falls outside the metas window
        // (robust against a mismatched fork point).
        heads[member.url] = encodeHeads([anchor.hash]);
      } else {
        let bestTime = -Infinity;
        metas.forEach((m, i) => {
          if (m.time <= anchor.time && m.time >= bestTime) {
            bestTime = m.time;
            pinnedIndex = i;
          }
        });
        if (pinnedIndex < 0) continue;
        heads[member.url] = encodeHeads([metas[pinnedIndex].hash]);
      }

      // Baseline = the change just before the pinned one. The first change has
      // no predecessor, so the baseline is `[]` (the whole doc reads as added).
      if (pinnedIndex >= 0) {
        const prev = metas[pinnedIndex - 1];
        baselineHeads[member.url] = encodeHeads(prev ? [prev.hash] : []);
      }
    } catch (err) {
      console.warn(
        "[drafts] failed to compute checkpoint for member:",
        member,
        err
      );
    }
  }
  return { anchor, heads, baselineHeads };
}

// Collect each member doc's post-fork changes as its own group, newest first,
// in member order (no cross-document interleave). On a draft `clonedAt` is set,
// so reading the clone since that fork point yields exactly the draft's own
// changes; on main both clone fields are null, so we read the original doc since
// `[]` for its full history. Members with no changes are omitted.
async function collectChangesByDocument(
  repo: Repo,
  members: DraftMemberDoc[]
): Promise<DraftChangeGroup[]> {
  const groups: DraftChangeGroup[] = [];
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const changes = Automerge.getChangesMetaSince(doc, since).map((meta) => ({
        docUrl: member.url,
        hash: meta.hash,
        time: meta.time,
        actor: meta.actor,
        message: meta.message,
      }));
      if (changes.length === 0) continue;
      changes.sort((a, b) => b.time - a.time);
      groups.push({ docUrl: member.url, changes });
    } catch (err) {
      // A member doc that can't be resolved (or whose fork point is missing)
      // is simply omitted rather than failing the whole list.
      console.warn("[drafts] failed to read changes for member:", member, err);
    }
  }
  return groups;
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
    hour12: true,
  });
  return `${datePart}, ${timePart}`;
}
