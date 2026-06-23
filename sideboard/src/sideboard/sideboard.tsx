import {
  makeDocumentProjection,
  useDocument,
} from "@automerge/automerge-repo-solid-primitives";

type TinyPatchworkAccountDoc = {
  rootFolderUrl: AutomergeUrl;
  moduleSettingsUrl: AutomergeUrl;
  contactUrl: AutomergeUrl;
};

import type { PatchworkToolProps } from "../types.ts";
import { filter, setFilter } from "./state.ts";
import CreateNew from "./create-new.tsx";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { createOpenEvent } from "./events.ts";
import { SearchIcon } from "./icons.tsx";
import { DocumentList } from "./document-list/document-list.tsx";
import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";
import { subscribe } from "@inkandswitch/patchwork-providers-solid";
import { createSignal, Show } from "solid-js";
import { handleFilesDrop } from "./document-list/file-drop.ts";
import { copyMode } from "./dnd/dnd.ts";
import { executeDrop } from "./dnd/operations.ts";
import { getDndPayload, hasDocumentDrag } from "./dnd/payload.ts";

export function Sideboard(
  props: PatchworkToolProps<TinyPatchworkAccountDoc | FolderDoc>
) {
  const doc = makeDocumentProjection(props.handle);
  const [folder, folderHandle] = useDocument<FolderDoc>(
    () => ("rootFolderUrl" in doc ? doc.rootFolderUrl : props.handle.url),
    props
  );

  const moduleSettingsUrl = () =>
    "moduleSettingsUrl" in doc ? doc.moduleSettingsUrl : undefined;
  const accountDocUrl = () => props.handle.url;
  const contactUrl = () => ("contactUrl" in doc ? doc.contactUrl : undefined);
  const selectedDocUrls = subscribe<AutomergeUrl[]>(
    props.element,
    { type: "patchwork:selected-doc" },
    []
  );

  function open(detail: OpenDocumentEventDetail) {
    props.element.dispatchEvent(createOpenEvent(detail));
  }

  const [isDraggingFile, setIsDraggingFile] = createSignal(false);

  return (
    <aside class="sideboard">
      <header class="sideboard-header">
        <CreateNew
          changeFolder={(fn) => folderHandle()?.change(fn)}
          repo={props.repo}
          hive={props.element.hive}
          open={open}
        />
      </header>
      <div class="sideboard__filter-container sideboard-widget">
        <SearchIcon />
        <input
          name="filter"
          class="sideboard__filter"
          placeholder="Filter by title"
          value={filter()}
          onInput={(event) => setFilter(event.target.value.toLowerCase())}
        />
      </div>
      <nav
        class="sideboard__doclist sideboard-widget"
        classList={{
          "sideboard__doclist--drag-over": isDraggingFile(),
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
          if (hasDocumentDrag(event.dataTransfer)) {
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
      </nav>
      <Show when={moduleSettingsUrl() && contactUrl()}>
        <footer class="sideboard-footer">
          <button
            onClick={() =>
              open({
                url: accountDocUrl(),
                toolId: "account-picker",
              })
            }
            class="sideboard-footer__button"
          >
            <patchwork-view doc-url={contactUrl()!} tool-id="contact-avatar" />
          </button>

          <button
            onClick={() => open({ url: moduleSettingsUrl()! })}
            class="sideboard-footer__button"
          >
            Packages
          </button>

          <button
            onClick={() =>
              open({
                url: accountDocUrl(),
                toolId: "frame-configurator",
              })
            }
            class="sideboard-footer__button"
          >
            Settings
          </button>
        </footer>
      </Show>
    </aside>
  );
}
