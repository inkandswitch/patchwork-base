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
  // The last *open* width applied during the live drag (null while the drag is
  // previewing a collapse). Read on release to decide whether to spring back.
  let lastDragWidth: number | null = null;

  const setWidth = (side: "left" | "right", w: number) =>
    side === "left" ? setLeftSidebarWidth(w) : setRightSidebarWidth(w);

  const setCollapsed = (side: "left" | "right", value: boolean) =>
    side === "left"
      ? setIsSidebarCollapsed(value)
      : setIsRightSidebarCollapsed(value);

  const isCollapsed = (side: "left" | "right") =>
    side === "left" ? isLeftCollapsed() : isRightCollapsed();

  // Apply a candidate width from a live drag. The panel tracks the pointer to
  // *any* size (Things 3 / nextaction feel) - it is allowed below `minWidth` so
  // you can see it shrink past the limit; the over-shrink is rejected later, on
  // release (see `settleDrag`). Below the auto-close threshold it snaps shut
  // live (so it reads as "let go here and it stays closed", and so the collapsed
  // 1px strip can be grabbed and dragged back open).
  const applyDragWidth = (side: "left" | "right", raw: number) => {
    if (raw < autoCloseWidth) {
      if (!isCollapsed(side)) setCollapsed(side, true);
      lastDragWidth = null;
      return;
    }
    if (isCollapsed(side)) setCollapsed(side, false);
    const w = Math.min(maxWidth, raw);
    setWidth(side, w);
    lastDragWidth = w;
  };

  // Decide the resting state when a drag ends. The width transition is live
  // again by now (the resizing flag was cleared in `endDrag`), so any width we
  // set here animates: if the drag finished too small (in the [auto-close, min)
  // band) the panel springs back out to `minWidth`; if it finished below
  // auto-close it already snapped collapsed during the drag, so we leave it.
  const settleDrag = (side: "left" | "right") => {
    if (isCollapsed(side)) return;
    if (lastDragWidth !== null && lastDragWidth < minWidth) {
      setWidth(side, minWidth);
    }
  };

  // A full-window overlay, added the moment a real drag begins. It keeps every
  // pointer event (and the resize cursor) on the parent document even as the
  // cursor passes over a tool iframe - otherwise the iframe swallows the
  // mousemove/mouseup and the drag can never end ("you can't let go"). It's
  // added lazily (not on mousedown) so a plain click still lands on the handle
  // and toggles collapse.
  let dragOverlay: HTMLDivElement | null = null;

  const beginDragVisuals = (side: "left" | "right") => {
    // suppress the width transition so the panel tracks the pointer 1:1, and tag
    // which side is dragging so the divider glow can extend up through the top
    // bar on that side (see `[data-sidebar-resizing]` rules in the stylesheet).
    document.body.setAttribute("data-sidebar-resizing", side);
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
    lastDragWidth = null;
    isResizing = side;
    document.body.style.userSelect = "none";
  };

  const handleMouseUp = () => {
    // Capture the drag state before endDrag() clears it, then resolve the
    // resting size with the width transition restored so spring-backs animate.
    const side = isResizing;
    const dragged = hasDragged;
    endDrag();
    if (side && dragged) settleDrag(side);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing || !dragStartPos) return;

    // Once past the threshold this is a drag: drop the overlay in now, before
    // the cursor can reach any iframe, and suppress the width transition.
    const deltaX = Math.abs(e.clientX - dragStartPos.x);
    const deltaY = Math.abs(e.clientY - dragStartPos.y);
    if (!hasDragged && (deltaX > dragThreshold || deltaY > dragThreshold)) {
      hasDragged = true;
      beginDragVisuals(isResizing);
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
