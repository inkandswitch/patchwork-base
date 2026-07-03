import { For, Show } from "solid-js";
import { useTaggedComponents } from "../hooks";

/**
 * A horizontal row of every `patchwork:component` tagged `"system-tray"`,
 * pinned to the bottom of the right context sidebar. Registry-driven — no
 * per-account configuration — so a component just declares the tag and shows
 * up here.
 */
export function Tray() {
  const items = useTaggedComponents("system-tray");

  return (
    <Show when={items().length}>
      <div class="frame-tray">
        <For each={items()}>
          {(item) => <patchwork-view component={item.id} />}
        </For>
      </div>
    </Show>
  );
}
