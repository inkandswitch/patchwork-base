import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { For, Show, type Accessor } from "solid-js";
import type { ThreepaneConfigDoc, ToolRef } from "../types";

const DOCUMENT_LIST_TOOL = "chee/document-list";

/**
 * The left pane: a stack of configured widgets (`[toolId, docId]`), each
 * rendered against its pinned doc. Normally seeded with a document list on the
 * account's root folder; the empty-state add button is a fallback for when no
 * widgets are configured (there's no add/remove UI yet).
 */
export function SidebarWidgets(props: {
  widgets: Accessor<ToolRef[]>;
  configHandle: Accessor<DocHandle<ThreepaneConfigDoc> | undefined>;
  rootFolderUrl: Accessor<AutomergeUrl | undefined>;
}) {
  const addDocumentList = () => {
    const root = props.rootFolderUrl();
    const handle = props.configHandle();
    if (!root || !handle) return;
    handle.change((doc) => {
      doc.sidebar.widgets.push([DOCUMENT_LIST_TOOL, root]);
    });
  };

  return (
    <div class="threepane-widgets">
      <Show
        when={props.widgets().length}
        fallback={
          // While the config/root folder are still loading we can't add a
          // widget yet — show nothing rather than a disabled button.
          <Show when={props.rootFolderUrl() && props.configHandle()}>
            <div class="threepane-widgets__empty">
              <button
                type="button"
                class="threepane-widgets__add"
                onClick={addDocumentList}
              >
                ＋ Add document list
              </button>
            </div>
          </Show>
        }
      >
        <For each={props.widgets()}>
          {(widget) => (
            <div class="threepane-widget">
              <patchwork-view doc-url={widget[1]} tool-id={widget[0]} />
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
