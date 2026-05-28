import "./styles.css";
import { createMemo, For, Show } from "solid-js";
import { useDocument } from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";

import { requestDoc } from "@inkandswitch/patchwork-providers-solid";
import { request } from "@inkandswitch/patchwork-providers";
import type {
  DraftDoc,
  DraftsState,
  HasDraftMarker,
} from "./draft-types";

const VERSION = "v0.2.0-per-doc";

export function DraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = requestDoc<HasDraftMarker>(
    props.element,
    "patchwork:host-doc"
  );
  const [, rootHandle] = requestDoc<DraftDoc>(
    props.element,
    "patchwork:draft-root"
  );
  const [state, stateHandle] = requestDoc<DraftsState>(
    props.element,
    "patchwork:drafts"
  );

  const drafts = createMemo<AutomergeUrl[]>(() => state()?.drafts ?? []);
  const selected = createMemo<AutomergeUrl | undefined>(
    () => state()?.selectedDraft
  );
  const hasDraftTree = createMemo(() => !!rootHandle());

  const selectDraft = (url: AutomergeUrl) => {
    stateHandle()?.change((d) => {
      d.selectedDraft = url;
    });
  };

  const getHostRepo = () =>
    request<Repo>(props.element, "patchwork:host-repo");

  const onCreateFirst = async () => {
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = await getHostRepo();
    if (!repo) {
      console.warn("[drafts] no `patchwork:host-repo` available");
      return;
    }
    const rootDraft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parentDraftUrl: null,
      drafts: [],
      clones: {},
    });
    const child = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parentDraftUrl: rootDraft.url,
      drafts: [],
      clones: {},
    });
    rootDraft.change((d) => {
      d.drafts.push(child.url);
    });
    docHandle.change((d) => {
      const existing = d["@patchwork"];
      const next =
        existing && typeof existing === "object" ? { ...existing } : {};
      if (!next.draftUrl) {
        next.draftUrl = rootDraft.url;
        d["@patchwork"] = next;
      }
    });
    // The provider picks up the doc change, builds DraftsState with
    // `selectedDraft = rootDraft.url`. We wait for that, then switch to
    // the new child.
    const stateReady = await waitForState(stateHandle);
    stateReady?.change((d) => {
      d.selectedDraft = child.url;
    });
  };

  const onCreateChild = async () => {
    const r = rootHandle();
    if (!r) return;
    const repo = await getHostRepo();
    if (!repo) return;
    const child = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parentDraftUrl: r.url,
      drafts: [],
      clones: {},
    });
    r.change((d) => {
      d.drafts.push(child.url);
    });
    selectDraft(child.url);
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
        <Show
          when={hasDraftTree()}
          fallback={
            <div class="flex flex-col gap-2 text-xs text-gray-500">
              <p>This document has no drafts yet.</p>
              <button class="btn btn-sm btn-primary" onClick={onCreateFirst}>
                Create first draft
              </button>
            </div>
          }
        >
          <div class="flex flex-col gap-1">
            <For each={drafts()}>
              {(url) => (
                <DraftCard
                  url={url}
                  isRoot={rootHandle()?.url === url}
                  isSelected={selected() === url}
                  onSelect={selectDraft}
                />
              )}
            </For>
          </div>

          <div class="flex justify-end">
            <button
              class="btn btn-sm btn-primary"
              onClick={onCreateChild}
              disabled={!rootHandle()}
              title="Create a new draft off the root"
            >
              New draft
            </button>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  isRoot: boolean;
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
        title={props.isRoot ? "Main version" : "Open draft"}
      >
        <div class="card-body p-2 space-y-1">
          <div class="text-sm font-medium flex items-center gap-2">
            <span>{props.isRoot ? "Main" : "Draft"}</span>
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

// `DraftsState` is created by the draft-root provider only after it sees
// `@patchwork.draftUrl` appear on the host doc — so on first-create there
// is a brief window where `stateHandle()` is undefined. Poll briefly.
async function waitForState(
  stateHandle: () => DocHandle<DraftsState> | undefined,
  attempts = 50,
  intervalMs = 50
): Promise<DocHandle<DraftsState> | undefined> {
  for (let i = 0; i < attempts; i++) {
    const h = stateHandle();
    if (h) return h;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}
