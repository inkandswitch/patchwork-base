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
  createDocumentProjection,
  useDocument,
} from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";

import { requestDoc } from "@inkandswitch/patchwork-providers-solid";
import { request } from "@inkandswitch/patchwork-providers";
import type {
  DraftDoc,
  DraftsState,
  HasDrafts,
} from "./draft-types";

const VERSION = "v0.4.2-baseline-debug";

export function DraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = requestDoc<HasDrafts>(
    props.element,
    "patchwork:host-doc"
  );

  const [stateHandle, setStateHandle] =
    createSignal<DocHandle<DraftsState> | undefined>();

  createEffect(() => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    void request<DocHandle<DraftsState> | null>(
      props.element,
      "patchwork:drafts"
    ).then((h) => {
      if (!cancelled && h) setStateHandle(() => h);
    });
  });

  const state = createDocumentProjection<DraftsState>(stateHandle);
  const drafts = createMemo<AutomergeUrl[]>(() => state()?.drafts ?? []);
  const selected = createMemo<AutomergeUrl | null>(
    () => state()?.selectedDraft ?? null
  );
  const isMainSelected = createMemo(() => selected() === null);

  const selectDraft = (url: AutomergeUrl | null) => {
    stateHandle()?.change((d) => {
      d.selectedDraft = url;
    });
  };

  const getHostRepo = () =>
    request<Repo>(props.element, "patchwork:host-repo");

  const onCreateDraft = async () => {
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = await getHostRepo();
    if (!repo) {
      console.warn("[drafts] no `patchwork:host-repo` available");
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

  return (
    <div class="h-full flex flex-col p-2 gap-2">
      <div class="flex items-center justify-between text-xs text-gray-400">
        <span class="font-medium">Drafts</span>
        <span>{VERSION}</span>
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

        <div class="flex justify-end">
          <button
            class="btn btn-sm btn-primary"
            onClick={onCreateDraft}
            title="Create a new draft off this document"
          >
            New draft
          </button>
        </div>
      </Show>
    </div>
  );
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

  return (
    <Show when={doc()}>
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
