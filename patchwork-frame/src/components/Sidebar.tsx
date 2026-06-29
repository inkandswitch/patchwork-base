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
};

/**
 * Reusable sidebar shell for left and right sidebars: owns the collapse/resize
 * chrome and renders either a tool view (`toolId`) or arbitrary `children`.
 * Props are accessed via `props.x` (not destructured) to preserve Solid reactivity.
 */
export function Sidebar(props: SidebarProps) {
  // Collapsed sidebars shrink to a 1px strip that still shows the divider line
  // (and its hover glow + grab pill), so it doubles as a drag-to-reopen handle.
  const widthStyle = () =>
    `${props.isCollapsed() ? 1 : props.width()}px`;

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

      {/* Sidebar content when expanded - right side */}
      {props.side === "right" && !props.isCollapsed() && content()}
    </div>
  );
}
