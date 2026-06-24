import "./styles.css";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  createDocSignal,
  useDocument,
} from "@automerge/automerge-repo-solid-primitives";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
  UrlHeads,
} from "@automerge/automerge-repo";
import * as Automerge from "@automerge/automerge";
import {
  subscribe,
  subscribeDoc,
} from "@inkandswitch/patchwork-providers-solid";
import type {
  CloneEntry,
  DraftDoc,
  DraftMemberDoc,
  DraftsState,
  HasDrafts,
} from "./draft-types";

export function DraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = subscribeDoc<HasDrafts>(props.element, {
    type: "draft:root-doc",
  });

  const [, stateHandle] = subscribeDoc<DraftsState>(props.element, {
    type: "draft:list",
  });

  // Read the DraftsState coarsely from the live handle (handle.doc()) rather
  // than a fine-grained patch-replay projection: the projection can render the
  // list doubled because it re-applies a change its initial snapshot already
  // reflects, whereas handle.doc() is always the correct materialized document.
  const stateDoc = createDocSignal(stateHandle);
  const drafts = createMemo<AutomergeUrl[]>(() => stateDoc()?.drafts ?? []);
  const selected = createMemo<AutomergeUrl | null>(
    () => stateDoc()?.selectedDraft ?? null
  );

  const isMainSelected = createMemo(() => selected() === null);
  // Drafting off a folder isn't supported yet, so creating a draft is disabled
  // while viewing a folder on Main.
  const isFolder = createMemo(
    () => hostDoc()?.["@patchwork"]?.type === "folder"
  );

  const selectDraft = (url: AutomergeUrl | null) => {
    stateHandle()?.change((d) => {
      d.selectedDraft = url;
    });
  };

  const getRepo = (): Repo | undefined =>
    "repo" in window ? window.repo : undefined;

  const onCreateDraft = async () => {
    if (isFolder()) return;
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }
    const draft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parent: docHandle.url,
      drafts: [],
      clones: {},
    });
    docHandle.change((d) => {
      const existing = d["@patchwork"];
      const next =
        existing && typeof existing === "object" ? { ...existing } : {};
      const list = Array.isArray(next.drafts) ? [...next.drafts] : [];
      list.push(draft.url);
      next.drafts = list;
      d["@patchwork"] = next;
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
            onSelect={() => selectDraft(null)}
          />
          <For each={drafts()}>
            {(url) => (
              <DraftCard
                url={url}
                isSelected={selected() === url}
                onSelect={selectDraft}
              />
            )}
          </For>
        </div>

        <div class="drafts-actions">
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

        <DraftChanges element={props.element} />
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
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class="draft-card"
      data-selected={props.isSelected ? "" : undefined}
      onClick={props.onSelect}
      title="Main version (host document)"
    >
      <div class="draft-card-body">
        <div class="draft-card-title">
          <span>Main</span>
          <Show when={props.isSelected}>
            <span class="draft-badge">current</span>
          </Show>
        </div>
        <div class="draft-card-url">
          {props.hostDocUrl ?? ""}
        </div>
      </div>
    </button>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  isSelected: boolean;
  onSelect: (url: AutomergeUrl) => void;
}) {
  const [doc] = useDocument<DraftDoc>(() => props.url);

  const cloneCount = createMemo(() => Object.keys(doc()?.clones ?? {}).length);
  const childCount = createMemo(() => doc()?.drafts.length ?? 0);
  const isVisible = createMemo(() => {
    const d = doc();
    return !!d && d.mergedAt === undefined;
  });

  return (
    <Show when={isVisible()}>
      <button
        type="button"
        class="draft-card"
        data-selected={props.isSelected ? "" : undefined}
        onClick={() => props.onSelect(props.url)}
        title="Open draft"
      >
        <div class="draft-card-body">
          <div class="draft-card-title">
            <span>Draft</span>
            <Show when={props.isSelected}>
              <span class="draft-badge">current</span>
            </Show>
          </div>
          <div class="draft-card-url">
            {props.url}
          </div>
          <div class="draft-card-meta">
            {cloneCount()} cloned doc(s) · {childCount()} draft(s)
          </div>
        </div>
      </button>
    </Show>
  );
}

// One change in the interleaved timeline. `docUrl` is the original member url
// (used for labelling), never the per-draft clone the change was read from.
type DraftChange = {
  docUrl: AutomergeUrl;
  hash: string;
  // Automerge change time, in SECONDS (multiply by 1000 for a JS Date).
  time: number;
  actor: string;
  message: string | null;
};

// Renders the changes that make up the current view (the selected draft, or
// main) as a single timeline merged across every member doc. The member set
// comes from `draft:member-docs`, so this follows selection automatically.
function DraftChanges(props: { element: HTMLElement }) {
  const members = subscribe<DraftMemberDoc[]>(
    props.element,
    { type: "draft:member-docs" },
    []
  );

  const [changes, setChanges] = createSignal<DraftChange[]>([]);

  // Whenever the member set changes, resolve a handle per member, listen for
  // edits so the timeline stays live, and recompute. A `disposed` flag guards
  // against the async resolution landing after the effect was torn down.
  createEffect(() => {
    const list = members();
    const repo = "repo" in window ? window.repo : undefined;
    if (!repo) return;

    let disposed = false;
    const listeners: { handle: DocHandle<unknown>; onChange: () => void }[] = [];

    const recompute = async () => {
      const rows = await collectInterleavedChanges(repo, list);
      if (!disposed) setChanges(rows);
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
    <div class="drafts-changes">
      <Show
        when={changes().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <For each={changes()}>
          {(change) => (
            <div class="draft-change-row">
              <span class="draft-change-time">{formatTime(change.time)}</span>
              <span class="draft-change-doc">{shortUrl(change.docUrl)}</span>
              <Show when={change.message}>
                <span class="draft-change-msg">{change.message}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

// Walk each member doc's post-fork changes and merge them into one timeline,
// newest first. On a draft `clonedAt` is set, so reading the clone since that
// fork point yields exactly the draft's own changes; on main both clone fields
// are null, so we read the original doc since `[]` for its full history.
async function collectInterleavedChanges(
  repo: Repo,
  members: DraftMemberDoc[]
): Promise<DraftChange[]> {
  const rows: DraftChange[] = [];
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since: UrlHeads | [] = member.clonedAt ?? [];
      const metas = Automerge.getChangesMetaSince(doc, since);
      for (const meta of metas) {
        rows.push({
          docUrl: member.url,
          hash: meta.hash,
          time: meta.time,
          actor: meta.actor,
          message: meta.message,
        });
      }
    } catch (err) {
      // A member doc that can't be resolved (or whose fork point is missing)
      // is simply omitted rather than failing the whole timeline.
      console.warn("[drafts] failed to read changes for member:", member, err);
    }
  }
  rows.sort((a, b) => b.time - a.time);
  return rows;
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
