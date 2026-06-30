import { useDocument } from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { createEffect, createSignal, onCleanup, Show, Suspense } from "solid-js";

import {
  filter,
  setFilter,
  setPendingNewDoc,
  setAutoExpandedFolders,
} from "./state.ts";
import { collectExpandedFolders } from "./document-list/auto-expand.ts";
import CreateNew from "./create-new.tsx";
import { createOpenEvent } from "./events.ts";
import { SearchIcon } from "./icons.tsx";
import { DocumentList } from "./document-list/document-list.tsx";
import { LoadingRows } from "./document-list/loading-row.tsx";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import { handleFilesDrop } from "./document-list/file-drop.ts";
import { copyMode, isNewDocDrag } from "./dnd/dnd.ts";
import { executeDrop } from "./dnd/operations.ts";
import { getDndPayload, hasDocumentDrag } from "./dnd/payload.ts";

/**
 * The document-list panel: a sticky toolbar (new-doc button + filter) over a
 * scrolling, recursive list of the folder's documents and subfolders. Renders a
 * single folder, given its url.
 */
export function DocumentListPanel(props: {
  folderUrl: AutomergeUrl;
  repo: Repo;
  element: PatchworkViewElement;
}) {
  const [folder, folderHandle] = useDocument<FolderDoc>(() => props.folderUrl, {
    repo: props.repo,
  });

  // Optimistic loading: show the skeleton from the moment the panel mounts and
  // keep it up until the root folder handle has actually resolved. Reading the
  // resource's `.state` (rather than `folder()`) never suspends, so the box +
  // toolbar paint immediately and the skeleton is guaranteed a beat of screen
  // time instead of relying on Suspense — which is skipped entirely when the
  // handle happens to resolve synchronously.
  const folderReady = () =>
    folderHandle.state === "ready" || folderHandle.state === "refreshing";

  const selectedDocUrls = subscribe<AutomergeUrl[]>(
    props.element,
    { type: "patchwork:selected-doc" },
    []
  );

  // Whenever the selection changes, walk the folder tree to find which folders
  // need to be open for the selected docs to be visible, and publish that set.
  // Each Folder reads it to auto-expand itself; expansion cascades down as each
  // level mounts, so even a deeply nested selection gets revealed.
  //
  // Gated on folderReady: the walk recursively finds folder docs across the
  // tree, so kicking it off before the root has loaded would flood the repo and
  // keep the whole widget blank. Let the top level paint first, then reveal.
  createEffect(() => {
    if (!folderReady()) return;
    const selected = selectedDocUrls();
    if (!selected.length) {
      setAutoExpandedFolders(new Set());
      return;
    }
    let cancelled = false;
    const result = new Set<AutomergeUrl>();
    collectExpandedFolders(
      props.repo,
      props.folderUrl,
      new Set(selected),
      result,
      new Set()
    ).then(() => {
      if (!cancelled) setAutoExpandedFolders(result);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  function open(detail: OpenDocumentEventDetail) {
    props.element.dispatchEvent(createOpenEvent(detail));
  }

  const [isDraggingFile, setIsDraggingFile] = createSignal(false);

  return (
    <aside class="document-list">
      <nav
        class="document-list__doclist document-list-widget"
        classList={{
          "document-list__doclist--drag-over": isDraggingFile(),
        }}
        role="tree"
        aria-multiselectable="true"
        onDragOver={(event: DragEvent) => {
          // File drops from OS
          if (event.dataTransfer?.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setIsDraggingFile(true);
            return;
          }
          // Item drags (dropping into the list's empty space appends to root)
          // and new-doc drags both append to the root list.
          if (hasDocumentDrag(event.dataTransfer) || isNewDocDrag(event)) {
            event.preventDefault();
            event.dataTransfer!.dropEffect = copyMode() ? "copy" : "move";
          }
        }}
        onDragLeave={(event: DragEvent) => {
          const related = event.relatedTarget as Element;
          if (!related || !(event.currentTarget as Element).contains(related)) {
            setIsDraggingFile(false);
          }
        }}
        onDrop={(event: DragEvent) => {
          event.preventDefault();
          setIsDraggingFile(false);

          // New-doc drag onto the list's empty space: append a placeholder at
          // the end of the root list.
          if (isNewDocDrag(event)) {
            const h = folderHandle();
            if (h) {
              const len = h.doc()?.docs?.length ?? 0;
              setPendingNewDoc({ containerUrl: h.url, index: len });
            }
            return;
          }

          const files = event.dataTransfer?.files;
          if (files && files.length > 0 && folderHandle()) {
            const folderDoc = folderHandle()!.doc();
            const insertIndex = folderDoc?.docs?.length || 0;
            handleFilesDrop(
              files,
              folderHandle()!,
              props.repo,
              "inside",
              insertIndex
            );
            return;
          }

          const payload = getDndPayload(event);
          if (!payload || !folderHandle()) return;

          const { source, items } = payload;
          const rootUrl = folderHandle()!.url;
          const docsLength = folderHandle()!.doc()?.docs?.length ?? 0;

          executeDrop(
            {
              draggedIds: items.map((i: { id: string }) => i.id),
              draggedUrls: items.map((i: { url: AutomergeUrl }) => i.url),
              draggedItems: items,
              // Append after the last root item; "inside" root if empty
              targetId:
                docsLength > 0 ? `${rootUrl}/${docsLength - 1}` : rootUrl,
              position: docsLength > 0 ? "below" : "inside",
              sourceToolId: source,
              copyMode: copyMode(),
            },
            props.repo,
            folderHandle.latest!,
            props.element.toolId!
          );
        }}
      >
        <div class="document-list__toolbar">
          <CreateNew
            square
            draggable
            changeFolder={(fn) => folderHandle()?.change(fn)}
            repo={props.repo}
            hive={props.element.hive}
            open={open}
          />
          <div class="document-list__filter-container">
            <SearchIcon />
            <input
              name="filter"
              class="document-list__filter"
              placeholder="Filter by title"
              value={filter()}
              onInput={(event) => setFilter(event.target.value.toLowerCase())}
            />
          </div>
        </div>
        <Show when={folderReady()} fallback={<LoadingRows depth={0} />}>
          <Suspense fallback={<LoadingRows depth={0} />}>
            <DocumentList
              depth={0}
              repo={props.repo}
              docs={folder()?.docs}
              handle={folderHandle.latest!}
              open={open}
              hive={props.element.hive}
              selectedDocUrls={selectedDocUrls()}
              element={props.element}
              rootFolderHandle={folderHandle.latest!}
            />
          </Suspense>
        </Show>
      </nav>
    </aside>
  );
}
