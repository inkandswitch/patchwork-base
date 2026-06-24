import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  getRegistry,
  type ToolDescription,
} from "@inkandswitch/patchwork-plugins";
import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { Sidebar } from "./Sidebar";

type ContextSidebarProps = {
  contextToolIds: Accessor<string[] | undefined>;
  docUrl: AutomergeUrl;
  /**
   * Selected tab, owned by the frame *above* the branch-switch boundary so it
   * survives document and branch switches (the tool content below still
   * remounts and re-scopes per draft).
   */
  selectedToolId: Accessor<string | undefined>;
  setSelectedToolId: (id: string) => void;
  isCollapsed: Accessor<boolean>;
  width: Accessor<number>;
  onMouseDown: (side: "left" | "right", e: MouseEvent) => void;
  onToggleClick: (side: "left" | "right", e: MouseEvent) => void;
  onClose: () => void;
};

/**
 * The document context sidebar: a tabbed Solid component that hosts the
 * configured context tools (`AccountDoc.contextToolIds`). Replaces the former
 * `context-sidebar` legacy tool, whose selected-tab state was local and reset
 * on every branch switch. Here the selection is lifted into the frame, so only
 * the per-tab tool content remounts.
 */
export function ContextSidebar(props: ContextSidebarProps) {
  const toolRegistry = getRegistry<ToolDescription>("patchwork:tool");

  // Tool descriptions can register/load late; bump a version so tab labels
  // recompute when the registry changes (mirrors the old tool's behaviour).
  const [registryVersion, setRegistryVersion] = createSignal(0);
  onMount(() => {
    const off = toolRegistry.on("changed", () => {
      setRegistryVersion((v) => v + 1);
    });
    onCleanup(off);
  });

  const toolIds = () => props.contextToolIds() ?? [];

  // The selection may name a tool that isn't in the current list (or be unset);
  // fall back to the first tab so there's always a valid active tool.
  const activeToolId = () => {
    const ids = toolIds();
    const selected = props.selectedToolId();
    return selected && ids.includes(selected) ? selected : ids[0];
  };

  const toolName = (id: string) => {
    registryVersion();
    return toolRegistry.get(id)?.name ?? id;
  };

  return (
    <Sidebar
      side="right"
      isCollapsed={props.isCollapsed}
      width={props.width}
      onMouseDown={props.onMouseDown}
      onToggleClick={props.onToggleClick}
    >
      <div class="context-sidebar">
        <div class="context-sidebar__tabs">
          <div role="tablist" class="context-sidebar__tablist">
            <For each={toolIds()}>
              {(id) => (
                <button
                  type="button"
                  role="tab"
                  class="context-sidebar__tab"
                  data-active={activeToolId() === id ? "" : undefined}
                  onClick={() => props.setSelectedToolId(id)}
                >
                  {toolName(id)}
                </button>
              )}
            </For>
          </div>
          <button
            type="button"
            class="context-sidebar__close"
            title="Close context sidebar"
            aria-label="Close context sidebar"
            onClick={() => props.onClose()}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M15 3v18" />
            </svg>
          </button>
        </div>
        <div class="context-sidebar__content">
          <Show when={activeToolId()} keyed>
            {(toolId) => (
              <patchwork-view doc-url={props.docUrl} tool-id={toolId} />
            )}
          </Show>
        </div>
      </div>
    </Sidebar>
  );
}
