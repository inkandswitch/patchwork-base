import { createSignal } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";

export const [dragging, setDragging] = createSignal(false);
export const [copyMode, setCopyMode] = createSignal(false);

// Dragging the "new document" button. Carries no document — on drop it asks the
// list to open a pending-doc placeholder at the drop location instead of moving
// anything.
export const NEW_DOC_DND_TYPE = "application/x-patchwork-new-doc";
export const [newDocDragging, setNewDocDragging] = createSignal(false);

export function isNewDocDrag(event: DragEvent) {
  return event.dataTransfer?.types.includes(NEW_DOC_DND_TYPE) ?? false;
}

export type DropPosition = "above" | "below" | "inside" | null;

// Drop target is a plain variable — not a SolidJS signal.
// Visual state is updated via direct DOM manipulation to avoid
// O(n) reactive updates across all items on every dragover.
let currentDropTarget: { id: string; position: DropPosition } | null = null;

export function getDropTarget() {
  return currentDropTarget;
}

function updateDropTargetDOM(
  oldTarget: { id: string; position: DropPosition } | null,
  newTarget: { id: string; position: DropPosition } | null
) {
  if (oldTarget) {
    const item = document.querySelector(
      `[data-dnd-item="${CSS.escape(oldTarget.id)}"]`
    );
    if (item) item.removeAttribute("data-dnd-droplist-state");
    const container = document.querySelector(
      `[data-dnd-container="${CSS.escape(oldTarget.id)}"]`
    );
    if (container) container.removeAttribute("data-drop-state");
  }
  if (newTarget) {
    const item = document.querySelector(
      `[data-dnd-item="${CSS.escape(newTarget.id)}"]`
    );
    if (item)
      item.setAttribute("data-dnd-droplist-state", newTarget.position ?? "");
    if (newTarget.position === "inside") {
      const container = document.querySelector(
        `[data-dnd-container="${CSS.escape(newTarget.id)}"]`
      );
      if (container) container.setAttribute("data-drop-state", "inside");
    }
  }
}

// Identity for the "did this drag start and end in the same view?" question.
// The answer decides move (→ in-view) vs add-link (→ cross-view or external).
//
// The tool id can't answer it: the sideboard is shown through patchwork-view's
// *fallback* path, which never sets the `tool-id` attribute, so element.toolId
// is null — and even when set it names the tool *type*, not the instance, so
// two side-by-side views would collide. The <patchwork-view> element itself is
// the instance identity. We're single-context on the web (dragstart and drop
// run in the same window), so plain reference equality is all we need: remember
// the origin element on dragstart, compare it on drop, clear it on dragend.
let dragOriginView: object | null = null;
export function setDragOriginView(element: object | null) {
  dragOriginView = element;
}
export function isSameDragOriginView(element: object): boolean {
  return dragOriginView != null && dragOriginView === element;
}

export type SideboardDragAndDropItem = {
  id: string;
  url: AutomergeUrl;
  type: string;
  name: string;
  source: string;
};

// Plain Map — not reactive. aria-checked is updated via DOM manipulation
// to avoid O(n) reactive updates when selection changes.
export const dragstack = new Map<string, SideboardDragAndDropItem>();

function setDragChecked(id: string, checked: boolean) {
  const el = document.querySelector(`[data-dnd-item="${CSS.escape(id)}"]`);
  if (el) {
    if (checked) {
      el.setAttribute("aria-checked", "true");
    } else {
      el.removeAttribute("aria-checked");
    }
  }
}

export function addToDragstack(id: string, item: SideboardDragAndDropItem) {
  dragstack.set(id, item);
  setDragChecked(id, true);
}

export function removeFromDragstack(id: string) {
  dragstack.delete(id);
  setDragChecked(id, false);
}

export function clearDragstack() {
  for (const id of dragstack.keys()) {
    setDragChecked(id, false);
  }
  dragstack.clear();
}

export function setDragSourceItems(ids: string[]) {
  for (const id of ids) {
    const el = document.querySelector(`[data-dnd-item="${CSS.escape(id)}"]`);
    if (el) el.setAttribute("data-dnd-dragging", "");
  }
}

export function clearDragSourceItems() {
  for (const el of document.querySelectorAll("[data-dnd-dragging]")) {
    el.removeAttribute("data-dnd-dragging");
  }
}

export function isAbove(clientY: number, element: Element) {
  const rect = element.getBoundingClientRect();
  const offset = clientY - rect.top;
  return offset < rect.height / 2;
}

export function clearDropTarget() {
  updateDropTargetDOM(currentDropTarget, null);
  currentDropTarget = null;
}

export function setDropTarget(
  target: { id: string; position: DropPosition } | null
) {
  // Only update if actually changed
  const current = currentDropTarget;
  if (!current && !target) return;
  if (
    current &&
    target &&
    current.id === target.id &&
    current.position === target.position
  ) {
    return;
  }

  updateDropTargetDOM(current, target);
  currentDropTarget = target;
}
