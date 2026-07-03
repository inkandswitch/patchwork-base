import {
  getRegistry,
  type ToolDescription,
} from "@inkandswitch/patchwork-plugins";
import { createSignal, onCleanup, onMount, For } from "solid-js";
import type { Accessor } from "solid-js";

type ContextTabsProps = {
  contextToolIds: Accessor<string[] | undefined>;
  selectedToolId: Accessor<string | undefined>;
  setSelectedToolId: (id: string) => void;
};

/**
 * The context sidebar's tab bar, lifted out of the sidebar and into the top
 * toolbar (it sits above the right sidebar). Horizontally scrollable when the
 * tabs overflow. Selection is owned by the frame so it survives branch switches.
 */
export function ContextTabs(props: ContextTabsProps) {
  const toolRegistry = getRegistry<ToolDescription>("patchwork:tool");
  // Context tabs can be tools or components, so labels come from either registry.
  const componentRegistry = getRegistry<ToolDescription>("patchwork:component");

  // Descriptions can register/load late; bump a version so tab labels recompute
  // when either registry changes.
  const [registryVersion, setRegistryVersion] = createSignal(0);
  onMount(() => {
    const bump = () => setRegistryVersion((v) => v + 1);
    const offTool = toolRegistry.on("changed", bump);
    const offComponent = componentRegistry.on("changed", bump);
    onCleanup(() => {
      offTool();
      offComponent();
    });
  });

  const toolIds = () => props.contextToolIds() ?? [];

  const activeToolId = () => {
    const ids = toolIds();
    const selected = props.selectedToolId();
    return selected && ids.includes(selected) ? selected : ids[0];
  };

  const toolName = (id: string) => {
    registryVersion();
    return toolRegistry.get(id)?.name ?? componentRegistry.get(id)?.name ?? id;
  };

  return (
    <div role="tablist" class="context-sidebar__tablist">
      <For each={toolIds()}>
        {(id) => (
          <button
            type="button"
            role="tab"
            class="context-sidebar__tab"
            data-active={activeToolId() === id ? "" : undefined}
            onClick={() => props.setSelectedToolId(id)}
          >
            {toolName(id)}
          </button>
        )}
      </For>
    </div>
  );
}
