import type { AutomergeUrl } from "@automerge/automerge-repo";
import {
  getRegistry,
  type ToolDescription,
} from "@inkandswitch/patchwork-plugins";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

/**
 * A horizontal row of every tool tagged `"tray"`, pinned to the bottom of the
 * right context sidebar. Tray tools render against the account document.
 */
export function Tray(props: { docUrl: AutomergeUrl }) {
  const toolRegistry = getRegistry<ToolDescription>("patchwork:tool");

  // Tools can register/load late; recompute the tray when the registry changes.
  const [registryVersion, setRegistryVersion] = createSignal(0);
  onMount(() => {
    const off = toolRegistry.on("changed", () => {
      setRegistryVersion((v) => v + 1);
    });
    onCleanup(off);
  });

  const trayTools = () => {
    registryVersion();
    return toolRegistry.filter((t) => (t.tags ?? []).includes("tray"));
  };

  return (
    <Show when={trayTools().length}>
      <div class="frame-tray">
        <For each={trayTools()}>
          {(tool) => <patchwork-view doc-url={props.docUrl} tool-id={tool.id} />}
        </For>
      </div>
    </Show>
  );
}
