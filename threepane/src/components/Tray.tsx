import { For, Show, type Accessor } from "solid-js";
import type { ToolSlot } from "../types";
import { SlotView } from "./SlotView";

/**
 * A horizontal row of configured tools, pinned to the bottom of the right
 * context sidebar. Like the doctitle, its entries come from the threepane
 * config doc: a `[toolId, docId]` tuple renders that tool against the document
 * the tuple names, while a bare string renders a `patchwork:component`.
 */
export function Tray(props: {
  slots: Accessor<ToolSlot[] | undefined>;
}) {
  const slots = () => props.slots() ?? [];

  return (
    <Show when={slots().length}>
      <div class="frame-tray">
        <For each={slots()}>
          {(slot) => <SlotView slot={slot} />}
        </For>
      </div>
    </Show>
  );
}
