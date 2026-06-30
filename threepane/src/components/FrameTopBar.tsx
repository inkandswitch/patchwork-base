import type { AutomergeUrl } from "@automerge/automerge-repo";
import { For, Show, type Accessor } from "solid-js";
import type { ToolSlot } from "../types";
import { ContextTabs } from "./ContextTabs";
import { DocumentTitle } from "./DocumentTitle";
import { slotId } from "./SlotView";

type FrameTopBarProps = {
  docUrl: Accessor<AutomergeUrl | undefined>;
  toolSlots: Accessor<ToolSlot[] | undefined>;

  isLeftCollapsed: Accessor<boolean>;

  contextToolIds: Accessor<string[] | undefined>;
  selectedContextToolId: Accessor<string | undefined>;
  setSelectedContextToolId: (id: string) => void;
  isRightCollapsed: Accessor<boolean>;
  rightWidth: Accessor<number>;
  onToggleRight: () => void;
};

/**
 * The full-width top toolbar: the document title and tool views, and — above the
 * right sidebar — the context tabs with a right sidebar toggle. Spans the main
 * column; the left sidebar toggle is pinned separately to the frame's top-left
 * corner. When the left sidebar is collapsed the bar reserves a matching slot at
 * its start so the title slides up against (not under) that toggle.
 */
export function FrameTopBar(props: FrameTopBarProps) {
  const hasRight = () => !!props.contextToolIds()?.length;
  // Title + spacer are intrinsic to the bar and never in the config (the
  // migration drops them), so the configured doctitle tools render as-is.
  const docToolSlots = () => props.toolSlots() ?? [];

  return (
    <div
      class="frame__topbar"
      classList={{ "frame__topbar--left-collapsed": props.isLeftCollapsed() }}
    >
      {/* document title, rendered intrinsically: shrinks to the title length,
          capped at half the bar. */}
      <Show when={props.docUrl()}>
        <div class="threepane__title">
          <DocumentTitle docUrl={props.docUrl} />
        </div>
      </Show>

      {/* built-in spacer */}
      <div class="threepane__spacer" />

      {/* configured doctitle tools, at the end on the right, scrollable.
          Unlike other lanes these always run against the currently selected
          main-view doc — they follow whatever document is open. Tuple and bare
          string are treated the same: take the slot's id as the tool, ignore
          any doc named in the tuple, and point it at the open doc. */}
      <Show when={props.docUrl() && docToolSlots().length}>
        <div class="threepane__doctitle-tools">
          <For each={docToolSlots()}>
            {(slot) => (
              <patchwork-view tool-id={slotId(slot)} doc-url={props.docUrl()} />
            )}
          </For>
        </div>
      </Show>

      <Show when={hasRight()}>
        <div
          class="frame__topbar-right"
          classList={{ "frame__topbar-right--collapsed": props.isRightCollapsed() }}
          style={
            props.isRightCollapsed()
              ? undefined
              : { width: `${props.rightWidth()}px` }
          }
        >
          <Show when={!props.isRightCollapsed()}>
            <ContextTabs
              contextToolIds={props.contextToolIds}
              selectedToolId={props.selectedContextToolId}
              setSelectedToolId={props.setSelectedContextToolId}
            />
          </Show>
          <button
            type="button"
            class="frame__sidebar-toggle"
            title={
              props.isRightCollapsed()
                ? "Show context sidebar"
                : "Hide context sidebar"
            }
            aria-label={
              props.isRightCollapsed()
                ? "Show context sidebar"
                : "Hide context sidebar"
            }
            aria-pressed={!props.isRightCollapsed()}
            onClick={() => props.onToggleRight()}
          >
            <PanelRightIcon />
          </button>
        </div>
      </Show>
    </div>
  );
}

// lucide `panel-right`
function PanelRightIcon() {
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
    </svg>
  );
}
