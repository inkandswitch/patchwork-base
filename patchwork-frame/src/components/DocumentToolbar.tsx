import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { Accessor } from "solid-js";
import { Show } from "solid-js";

interface DocumentToolbarProps {
  toolIds: Accessor<string[] | undefined>;
  docUrl: Accessor<AutomergeUrl | undefined>;
  /** Show a "bring back the left sidebar" button at the start of the toolbar. */
  showLeftSidebarButton?: Accessor<boolean>;
  onShowLeftSidebar?: () => void;
  /** Show a "bring back the right sidebar" button at the end of the toolbar. */
  showRightSidebarButton?: Accessor<boolean>;
  onShowRightSidebar?: () => void;
}

export function DocumentToolbar(props: DocumentToolbarProps) {
  return (
    <Show when={props.docUrl() && props.toolIds()} keyed>
      {(ids) => (
        <div class="toolbar">
          <Show when={props.showLeftSidebarButton?.()}>
            <button
              type="button"
              class="toolbar__sidebar-toggle toolbar__sidebar-toggle--left"
              title="Show sidebar"
              aria-label="Show sidebar"
              onClick={() => props.onShowLeftSidebar?.()}
            >
              <PanelLeftOpenIcon />
            </button>
          </Show>

          {ids.map((toolId) => (
            <patchwork-view doc-url={props.docUrl()!} tool-id={toolId} />
          ))}

          <Show when={props.showRightSidebarButton?.()}>
            <button
              type="button"
              class="toolbar__sidebar-toggle toolbar__sidebar-toggle--right"
              title="Show context sidebar"
              aria-label="Show context sidebar"
              onClick={() => props.onShowRightSidebar?.()}
            >
              <PanelRightOpenIcon />
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

// lucide `panel-left-open`
function PanelLeftOpenIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </svg>
  );
}

// lucide `panel-right-open`
function PanelRightOpenIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
      <path d="m10 15-3-3 3-3" />
    </svg>
  );
}
