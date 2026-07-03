import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { Accessor, JSX } from "solid-js";

type SidebarProps = {
  side: "left" | "right";
  isCollapsed: Accessor<boolean>;
  width: Accessor<number>;
  toolId?: string;
  docUrl?: AutomergeUrl;
  onMouseDown: (side: "left" | "right", e: MouseEvent) => void;
  onToggleClick: (side: "left" | "right", e: MouseEvent) => void;
  /**
   * Content slot. When provided it replaces the default `<patchwork-view>`
   * (driven by `toolId`/`docUrl`), letting callers render arbitrary Solid
   * content inside the shared sidebar chrome (collapse/resize/toggle).
   */
  children?: JSX.Element;
  /**
   * Keep the content mounted while collapsed instead of tearing it down. The
   * shell still shrinks to 0px; callers must hide the persisted content via CSS
   * (it would otherwise spill out, since the shell's overflow is visible). Used
   * by the context sidebar so the system tray's tools stay alive when closed.
   */
  persistContent?: boolean;
};

/**
 * Reusable sidebar shell for left and right sidebars: owns the collapse/resize
 * chrome and renders either a tool view (`toolId`) or arbitrary `children`.
 * Props are accessed via `props.x` (not destructured) to preserve Solid reactivity.
 */
export function Sidebar(props: SidebarProps) {
  // Collapsed sidebars shrink to zero width. The resize/toggle button still
  // renders and straddles the edge (it reserves no layout column), so it stays
  // grabbable as a drag-to-reopen handle even at 0px.
  const widthStyle = () =>
    `${props.isCollapsed() ? 0 : props.width()}px`;

  const content = () => {
    if (props.children !== undefined) return props.children;
    if (props.toolId && props.docUrl) {
      return <patchwork-view doc-url={props.docUrl} tool-id={props.toolId} />;
    }
    return null;
  };

  return (
    <div
      class="sidebar"
      data-side={props.side}
      data-collapsed={props.isCollapsed() ? "" : undefined}
      style={{ width: widthStyle() }}
    >
      {/* Sidebar content when expanded - left side */}
      {props.side === "left" && !props.isCollapsed() && content()}

      {/* Toggle/resize button - left side shows when expanded */}
      {props.side === "left" && !props.isCollapsed() && (
        <button
          onClick={(e) => props.onToggleClick(props.side, e)}
          onMouseDown={(e) => props.onMouseDown(props.side, e)}
          class="sidebar-toggle sidebar-toggle--resizable"
          aria-label="Toggle or resize sidebar"
          title="Click to toggle, drag to resize"
        />
      )}

      {/* Toggle button when collapsed - left side */}
      {props.side === "left" && props.isCollapsed() && (
        <button
          onClick={(e) => props.onToggleClick(props.side, e)}
          onMouseDown={(e) => props.onMouseDown(props.side, e)}
          class="sidebar-toggle sidebar-toggle--resizable"
          aria-label="Expand sidebar"
          title="Click to expand, drag to resize"
        />
      )}

      {/* Toggle/resize button - right side shows when expanded */}
      {props.side === "right" && !props.isCollapsed() && (
        <button
          onClick={(e) => props.onToggleClick(props.side, e)}
          onMouseDown={(e) => props.onMouseDown(props.side, e)}
          class="sidebar-toggle sidebar-toggle--resizable"
          aria-label="Toggle or resize sidebar"
          title="Click to toggle, drag to resize"
        />
      )}

      {/* Toggle button when collapsed - right side */}
      {props.side === "right" && props.isCollapsed() && (
        <button
          onClick={(e) => props.onToggleClick(props.side, e)}
          onMouseDown={(e) => props.onMouseDown(props.side, e)}
          class="sidebar-toggle sidebar-toggle--resizable"
          aria-label="Expand sidebar"
          title="Click to expand, drag to resize"
        />
      )}

      {/* Sidebar content - right side. With persistContent it stays mounted
          while collapsed (hidden via CSS) so e.g. the system tray keeps running. */}
      {props.side === "right" &&
        (props.persistContent || !props.isCollapsed()) &&
        content()}
    </div>
  );
}
