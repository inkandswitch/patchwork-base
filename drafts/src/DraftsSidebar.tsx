import "./styles.css";
import { createMemo, For, Show } from "solid-js";
import { useDocument } from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import type {
  CloneEntry,
  DraftDoc,
  DraftsState,
  HasDrafts,
} from "./draft-types";

export function DraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = subscribeDoc<HasDrafts>(props.element, {
    type: "draft:root-doc",
  });

  const [state, stateHandle] = subscribeDoc<DraftsState>(props.element, {
    type: "draft:list",
  });

  const drafts = createMemo<AutomergeUrl[]>(() => state()?.drafts ?? []);
  const selected = createMemo<AutomergeUrl | null>(
    () => state()?.selectedDraft ?? null
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
    <div class="h-full flex flex-col p-2 gap-2">
      <div class="flex items-center justify-between text-xs text-gray-400">
        <span class="font-medium">Drafts</span>
      </div>

      <Show
        when={hostDoc()}
        fallback={
          <div class="text-xs text-gray-400">No document selected.</div>
        }
      >
        <div class="flex flex-col gap-1">
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

        <div class="flex flex-col items-end gap-1">
          <Show when={isMainSelected()}>
            <button
              class="btn btn-sm btn-primary"
              classList={{ "btn-disabled": isFolder() }}
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
              <span class="text-xs text-gray-400 italic">
                Drafts aren't supported for folders yet.
              </span>
            </Show>
          </Show>
          <Show when={!isMainSelected()}>
            <button
              class="btn btn-sm btn-warning"
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
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      class="text-left card card-bordered shadow-sm border hover:bg-gray-50"
      classList={{
        "bg-base-200 border-primary ring-1 ring-primary": props.isSelected,
        "bg-white border-gray-200": !props.isSelected,
      }}
      onClick={props.onSelect}
      title="Main version (host document)"
    >
      <div class="card-body p-2 space-y-1">
        <div class="text-sm font-medium flex items-center gap-2">
          <span>Main</span>
          <Show when={props.isSelected}>
            <span class="badge badge-xs badge-primary">current</span>
          </Show>
        </div>
        <div class="text-xs text-gray-500 font-mono break-all">
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
        class="text-left card card-bordered shadow-sm border hover:bg-gray-50"
        classList={{
          "bg-base-200 border-primary ring-1 ring-primary": props.isSelected,
          "bg-white border-gray-200": !props.isSelected,
        }}
        onClick={() => props.onSelect(props.url)}
        title="Open draft"
      >
        <div class="card-body p-2 space-y-1">
          <div class="text-sm font-medium flex items-center gap-2">
            <span>Draft</span>
            <Show when={props.isSelected}>
              <span class="badge badge-xs badge-primary">current</span>
            </Show>
          </div>
          <div class="text-xs text-gray-500 font-mono break-all">
            {props.url}
          </div>
          <div class="text-xs text-gray-400">
            {cloneCount()} cloned doc(s) · {childCount()} draft(s)
          </div>
        </div>
      </button>
    </Show>
  );
}
