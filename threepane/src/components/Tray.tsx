import { For, Show, type Accessor } from "solid-js";
import type { ToolSlot } from "../types";
import { SlotView, slotId } from "./SlotView";

/**
 * A horizontal row of the system-tray tools configured in the threepane config
 * doc's `tray` array, pinned to the bottom of the left sidebar. Explicitly
 * configured (no longer registry-driven) — each slot is rendered via SlotView,
 * so a bare component id renders as a `patchwork:component` with no document and
 * a `[toolId, docId]` tuple renders that tool against its pinned doc.
 */
export function Tray(props: { slots: Accessor<ToolSlot[]> }) {
  return (
    <Show when={props.slots().length}>
      <div class="frame-tray">
        <For each={props.slots()}>
          {(slot) => (
            <div class="frame-tray__item" data-tray-id={slotId(slot)}>
              <SlotView slot={slot} />
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
