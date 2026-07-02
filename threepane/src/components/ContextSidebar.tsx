import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { ToolSlot } from "../types";
import { Sidebar } from "./Sidebar";
import { ContextTabs } from "./ContextTabs";
import { SlotView, slotId } from "./SlotView";
import { Tray } from "./Tray";

type ContextSidebarProps = {
  contextToolIds: Accessor<string[] | undefined>;
  /** Full slots for the context tabs; the active one is rendered via SlotView
   *  (a tool tuple against the doc it names, or a bare component id). */
  contextToolSlots: Accessor<ToolSlot[] | undefined>;
  traySlots: Accessor<ToolSlot[] | undefined>;
  /**
   * Selected tab, owned by the frame *above* the branch-switch boundary so it
   * survives document and branch switches.
   */
  selectedToolId: Accessor<string | undefined>;
  setSelectedToolId: (id: string) => void;
  isCollapsed: Accessor<boolean>;
  width: Accessor<number>;
  onMouseDown: (side: "left" | "right", e: MouseEvent) => void;
  onToggleClick: (side: "left" | "right", e: MouseEvent) => void;
  /** Collapse the sidebar, from its own tab-header button. */
  onCollapse: () => void;
};

/**
 * The document context sidebar: a full-height column with its own tab header
 * (the tabs that select the active tool, plus a collapse button), the active
 * context tool's content, and the bottom tray. Living inside the sidebar — not
 * up in the top bar — lets the resize divider on its left edge run the whole
 * frame height and be draggable end to end, exactly like the left sidebar.
 */
export function ContextSidebar(props: ContextSidebarProps) {
  const toolIds = () => props.contextToolIds() ?? [];

  // The selection may name a tool that isn't in the current list (or be unset);
  // fall back to the first tab so there's always a valid active tool.
  const activeToolId = () => {
    const ids = toolIds();
    const selected = props.selectedToolId();
    return selected && ids.includes(selected) ? selected : ids[0];
  };

  // The slot backing the active tab, used to render it as a tool or component.
  const activeSlot = (): ToolSlot | undefined => {
    const id = activeToolId();
    return props.contextToolSlots()?.find((slot) => slotId(slot) === id);
  };

  return (
    <Sidebar
      side="right"
      isCollapsed={props.isCollapsed}
      width={props.width}
      onMouseDown={props.onMouseDown}
      onToggleClick={props.onToggleClick}
      persistContent
    >
      {/* Persisted while collapsed (hidden via CSS) so the tray keeps running.
          The active context tool itself still tears down on collapse — only the
          system tray needs to stay alive secretly. */}
      <div class="context-sidebar">
        {/* Tab header: selects the active tool, with a collapse button at the
            end. Only when there are tabs — a tray-only sidebar has no header
            and is collapsed via the resize handle. */}
        <Show when={toolIds().length}>
          <div class="context-sidebar__tabs">
            <ContextTabs
              contextToolIds={props.contextToolIds}
              selectedToolId={props.selectedToolId}
              setSelectedToolId={props.setSelectedToolId}
            />
            <button
              type="button"
              class="context-sidebar__close"
              title="Hide context sidebar"
              aria-label="Hide context sidebar"
              onClick={() => props.onCollapse()}
            >
              <PanelRightIcon />
            </button>
          </div>
        </Show>
        <Show when={!props.isCollapsed()}>
          <div class="context-sidebar__content">
            <Show when={activeToolId()} keyed>
              {() => (
                <Show when={activeSlot()}>
                  {(slot) => <SlotView slot={slot()} />}
                </Show>
              )}
            </Show>
          </div>
        </Show>
        <Tray slots={props.traySlots} />
      </div>
    </Sidebar>
  );
}

// lucide `panel-right`
export function PanelRightIcon() {
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
