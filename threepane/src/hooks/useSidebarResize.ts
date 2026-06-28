import { onCleanup, onMount } from "solid-js";
import type { Setter } from "solid-js";

interface UseSidebarResizeParams {
  setLeftSidebarWidth: Setter<number>;
  setRightSidebarWidth: Setter<number>;
  setIsSidebarCollapsed: Setter<boolean>;
  setIsRightSidebarCollapsed: Setter<boolean>;
  isLeftCollapsed: () => boolean;
  isRightCollapsed: () => boolean;
  minWidth: number;
  maxWidth: number;
  /** Drag narrower than this and the sidebar snaps closed (and re-opens once
   * dragged back out past it). */
  autoCloseWidth: number;
  dragThreshold: number;
}

/**
 * Manages sidebar resize and toggle interactions
 */
export function useSidebarResize({
  setLeftSidebarWidth,
  setRightSidebarWidth,
  setIsSidebarCollapsed,
  setIsRightSidebarCollapsed,
  isLeftCollapsed,
  isRightCollapsed,
  minWidth,
  maxWidth,
  autoCloseWidth,
  dragThreshold,
}: UseSidebarResizeParams) {
  // Non-reactive refs for drag state
  let isResizing: "left" | "right" | null = null;
  let dragStartPos: { x: number; y: number } | null = null;
  let hasDragged = false;

  const setWidth = (side: "left" | "right", w: number) =>
    side === "left" ? setLeftSidebarWidth(w) : setRightSidebarWidth(w);

  const setCollapsed = (side: "left" | "right", value: boolean) =>
    side === "left"
      ? setIsSidebarCollapsed(value)
      : setIsRightSidebarCollapsed(value);

  const isCollapsed = (side: "left" | "right") =>
    side === "left" ? isLeftCollapsed() : isRightCollapsed();

  // Apply a candidate width from a drag: snap closed below the auto-close
  // threshold (keeping the last good width so re-opening restores it), pop back
  // open once dragged past it, and clamp to [min, max] otherwise.
  const applyDragWidth = (side: "left" | "right", raw: number) => {
    if (raw < autoCloseWidth) {
      if (!isCollapsed(side)) setCollapsed(side, true);
      return;
    }
    if (isCollapsed(side)) setCollapsed(side, false);
    setWidth(side, Math.min(maxWidth, Math.max(minWidth, raw)));
  };

  // A full-window overlay, added the moment a real drag begins. It keeps every
  // pointer event (and the resize cursor) on the parent document even as the
  // cursor passes over a tool iframe - otherwise the iframe swallows the
  // mousemove/mouseup and the drag can never end ("you can't let go"). It's
  // added lazily (not on mousedown) so a plain click still lands on the handle
  // and toggles collapse.
  let dragOverlay: HTMLDivElement | null = null;

  const beginDragVisuals = () => {
    // suppress the width transition so the panel tracks the pointer 1:1
    document.body.setAttribute("data-sidebar-resizing", "");
    dragOverlay = document.createElement("div");
    dragOverlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;";
    document.body.appendChild(dragOverlay);
  };

  const endDrag = () => {
    isResizing = null;
    dragStartPos = null;
    document.body.style.userSelect = "";
    document.body.removeAttribute("data-sidebar-resizing");
    dragOverlay?.remove();
    dragOverlay = null;
  };

  const handleMouseDown = (side: "left" | "right", e: MouseEvent) => {
    e.preventDefault();
    dragStartPos = { x: e.clientX, y: e.clientY };
    hasDragged = false;
    isResizing = side;
    document.body.style.userSelect = "none";
  };

  const handleMouseUp = () => {
    endDrag();
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing || !dragStartPos) return;

    // Once past the threshold this is a drag: drop the overlay in now, before
    // the cursor can reach any iframe, and suppress the width transition.
    const deltaX = Math.abs(e.clientX - dragStartPos.x);
    const deltaY = Math.abs(e.clientY - dragStartPos.y);
    if (!hasDragged && (deltaX > dragThreshold || deltaY > dragThreshold)) {
      hasDragged = true;
      beginDragVisuals();
    }

    if (isResizing === "left") {
      applyDragWidth("left", e.clientX);
    } else if (isResizing === "right") {
      applyDragWidth("right", window.innerWidth - e.clientX);
    }
  };

  const handleToggleClick = (side: "left" | "right", e: MouseEvent) => {
    // Only toggle if we didn't drag
    if (hasDragged) {
      e.preventDefault();
      e.stopPropagation();
      // Reset the flag for next interaction
      hasDragged = false;
      return;
    }

    if (side === "left") {
      setIsSidebarCollapsed((prev) => !prev);
    } else {
      setIsRightSidebarCollapsed((prev) => !prev);
    }
  };

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    onCleanup(() => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      // Reset body styles if component unmounts during drag
      if (isResizing) {
        endDrag();
      }
    });
  });

  return {
    handleMouseDown,
    handleToggleClick,
  };
}
