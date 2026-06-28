import type { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { For, Show, type Accessor } from "solid-js";
import { ContextTabs } from "./ContextTabs";
import { DocumentTitle } from "./DocumentTitle";

// Title + spacer are rendered intrinsically by the frame's top bar, so they're
// dropped from the configured doctitle tools (which sit to the right).
const TITLE_TOOL = "document-title";
const SPACER_TOOL = "spacer";

type FrameTopBarProps = {
  repo: Repo;
  docUrl: Accessor<AutomergeUrl | undefined>;
  toolIds: Accessor<string[] | undefined>;

  hasLeftSidebar: Accessor<boolean>;
  isLeftCollapsed: Accessor<boolean>;
  onToggleLeft: () => void;

  contextToolIds: Accessor<string[] | undefined>;
  selectedContextToolId: Accessor<string | undefined>;
  setSelectedContextToolId: (id: string) => void;
  isRightCollapsed: Accessor<boolean>;
  rightWidth: Accessor<number>;
  onToggleRight: () => void;
};

/**
 * The full-width top toolbar: a left sidebar toggle, the document tool views,
 * and — above the right sidebar — the context tabs with a right sidebar toggle.
 * Spans the main column; the left sidebar's reserved top margin lines up with it
 * so it reads as one continuous bar across the top.
 */
export function FrameTopBar(props: FrameTopBarProps) {
  const hasRight = () => !!props.contextToolIds()?.length;
  const docToolIds = () =>
    (props.toolIds() ?? []).filter(
      (id) => id !== TITLE_TOOL && id !== SPACER_TOOL
    );

  return (
    <div class="frame__topbar">
      <Show when={props.hasLeftSidebar()}>
        <button
          type="button"
          class="frame__sidebar-toggle"
          title={props.isLeftCollapsed() ? "Show sidebar" : "Hide sidebar"}
          aria-label={props.isLeftCollapsed() ? "Show sidebar" : "Hide sidebar"}
          aria-pressed={!props.isLeftCollapsed()}
          onClick={() => props.onToggleLeft()}
        >
          <PanelLeftIcon />
        </button>
      </Show>

      {/* document title, rendered intrinsically: shrinks to the title length,
          capped at half the bar. */}
      <Show when={props.docUrl()}>
        <div class="threepane__title">
          <DocumentTitle docUrl={props.docUrl} repo={props.repo} />
        </div>
      </Show>

      {/* built-in spacer */}
      <div class="threepane__spacer" />

      {/* configured doctitle tools, at the end on the right, scrollable */}
      <Show when={props.docUrl() && docToolIds().length}>
        <div class="threepane__doctitle-tools">
          <For each={docToolIds()}>
            {(id) => <patchwork-view doc-url={props.docUrl()!} tool-id={id} />}
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

// lucide `panel-left`
function PanelLeftIcon() {
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
    </svg>
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
