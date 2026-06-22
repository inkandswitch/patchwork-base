import "./styles.css";
import type { DocHandle } from "@automerge/automerge-repo";
import type { ToolElement, ToolDescription } from "@inkandswitch/patchwork-plugins";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import {
  useDocument,
  RepoContext,
} from "@automerge/automerge-repo-solid-primitives";
import {
  createSignal,
  createMemo,
  For,
  Show,
  onCleanup,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { TinyPatchworkLayoutDoc } from "./types";

type ModuleOption = {
  id: string;
  name: string;
};

function useToolDescriptions() {
  const registry = getRegistry<ToolDescription>("patchwork:tool");
  const [tools, setTools] = createStore<ToolDescription[]>(
    (registry.all?.() ?? []).map((p) => p as unknown as ToolDescription)
  );
  const update = () => {
    const all = (registry.all?.() ?? []).map(
      (p) => p as unknown as ToolDescription
    );
    setTools(reconcile(all));
  };
  update();
  const dispose = registry.on("changed", update);
  onCleanup(dispose);
  return tools;
}

function filterToolsByTag(tools: ToolDescription[], tag: string): ModuleOption[] {
  return tools
    .filter((t) => (t.tags ?? []).includes(tag))
    .map((t) => ({ id: t.id, name: t.name || t.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function SortableItem(props: {
  id: string;
  name: string;
  index: number;
  onRemove: () => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  return (
    <li
      class="sortable-item"
      draggable={true}
      style={{ opacity: props.dragging ? "0.5" : "1" }}
      onDragStart={(e) => {
        e.dataTransfer!.effectAllowed = "move";
        props.onDragStart(props.index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        props.onDragOver(props.index);
      }}
      onDragEnd={() => props.onDragEnd()}
    >
      <span class="drag-handle" aria-label="Drag to reorder">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <circle cx="3.5" cy="2" r="1.2" />
          <circle cx="8.5" cy="2" r="1.2" />
          <circle cx="3.5" cy="6" r="1.2" />
          <circle cx="8.5" cy="6" r="1.2" />
          <circle cx="3.5" cy="10" r="1.2" />
          <circle cx="8.5" cy="10" r="1.2" />
        </svg>
      </span>
      <span class="item-label">{props.name}</span>
      <button
        class="remove-btn"
        onClick={() => props.onRemove()}
        aria-label={`Remove ${props.name}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        >
          <line x1="4" y1="4" x2="10" y2="10" />
          <line x1="10" y1="4" x2="4" y2="10" />
        </svg>
      </button>
    </li>
  );
}

const PlusIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
  >
    <line x1="7" y1="3" x2="7" y2="11" />
    <line x1="3" y1="7" x2="11" y2="7" />
  </svg>
);

function SortableList(props: {
  label: string;
  values: string[] | undefined;
  setValues: (next: string[]) => void;
  allOptions: ModuleOption[];
}) {
  const [showAdd, setShowAdd] = createSignal(false);
  const [customId, setCustomId] = createSignal("");
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);

  const currentIds = createMemo(() => new Set(props.values ?? []));
  const available = createMemo(() =>
    props.allOptions.filter((o) => !currentIds().has(o.id))
  );

  const nameOf = (id: string) =>
    props.allOptions.find((o) => o.id === id)?.name ?? id;

  const items = createMemo(() => props.values ?? []);

  const removeAt = (index: number) => {
    const vals = props.values;
    if (!vals) return;
    props.setValues(vals.filter((_, i) => i !== index));
  };

  const add = (id: string) => {
    props.setValues([...(props.values ?? []), id]);
  };

  const addCustom = () => {
    const id = customId().trim();
    if (!id) return;
    props.setValues([...(props.values ?? []), id]);
    setCustomId("");
  };

  let dragOverIndex: number | null = null;

  const handleDragOver = (index: number) => {
    dragOverIndex = index;
  };

  const handleDragEnd = () => {
    const from = dragIndex();
    const to = dragOverIndex;
    setDragIndex(null);
    dragOverIndex = null;
    if (from == null || to == null || from === to) return;
    const arr = [...(props.values ?? [])];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    props.setValues(arr);
  };

  return (
    <fieldset class="config-section">
      <legend class="section-label">{props.label}</legend>
      <ul class="sortable-list">
        <For each={items()}>
          {(id, index) => (
            <SortableItem
              id={id}
              name={nameOf(id)}
              index={index()}
              onRemove={() => removeAt(index())}
              onDragStart={setDragIndex}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              dragging={dragIndex() === index()}
            />
          )}
        </For>
      </ul>

      <Show
        when={showAdd()}
        fallback={
          <button class="add-btn" onClick={() => setShowAdd(true)}>
            <PlusIcon />
            Add
          </button>
        }
      >
        <div class="add-menu">
          <For each={available()}>
            {(opt) => (
              <button class="add-option" onClick={() => add(opt.id)}>
                <PlusIcon />
                {opt.name}
              </button>
            )}
          </For>
          <div class="add-custom">
            <input
              type="text"
              class="add-custom-input"
              placeholder="tool-id"
              value={customId()}
              onInput={(e) => setCustomId(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && addCustom()}
            />
            <button
              class="add-custom-btn"
              onClick={addCustom}
              disabled={!customId().trim()}
            >
              <PlusIcon />
            </button>
          </div>
          <button
            class="add-cancel"
            onClick={() => {
              setShowAdd(false);
              setCustomId("");
            }}
          >
            Done
          </button>
        </div>
      </Show>
    </fieldset>
  );
}

function SingleSelect(props: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  options: ModuleOption[];
}) {
  return (
    <fieldset class="config-section">
      <legend class="section-label">{props.label}</legend>
      <Show
        when={props.options.length > 0}
        fallback={<p class="empty-message">No tools available</p>}
      >
        <div class="radio-group">
          <For each={props.options}>
            {(opt) => (
              <label class="radio-option">
                <input
                  type="radio"
                  name={props.label}
                  checked={props.value === opt.id}
                  onChange={() => props.onChange(opt.id)}
                />
                <span>{opt.name}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </fieldset>
  );
}

function FrameConfiguratorUI(props: {
  handle: DocHandle<TinyPatchworkLayoutDoc>;
}) {
  const [accountDoc, changeAccountDoc] = useDocument<TinyPatchworkLayoutDoc>(
    () => props.handle.url
  );

  const allTools = useToolDescriptions();

  const frameOptions = createMemo(() =>
    filterToolsByTag([...allTools], "frame-tool")
  );
  const sidebarOptions = createMemo(() =>
    filterToolsByTag([...allTools], "sidebar-account")
  );
  const contextSidebarOptions = createMemo(() =>
    filterToolsByTag([...allTools], "sidebar-context")
  );
  const documentToolbarOptions = createMemo(() =>
    filterToolsByTag([...allTools], "titlebar-tool")
  );
  const contextToolOptions = createMemo(() =>
    filterToolsByTag([...allTools], "context-tool")
  );

  const setField = <K extends keyof TinyPatchworkLayoutDoc>(
    key: K,
    value: TinyPatchworkLayoutDoc[K]
  ) => {
    changeAccountDoc((doc: any) => {
      doc[key] = value as any;
    });
  };

  const setArrayField = (
    key: keyof TinyPatchworkLayoutDoc,
    next: string[]
  ) => {
    changeAccountDoc((doc: any) => {
      const arr = doc[key];
      arr.splice(0, arr.length, ...next);
    });
  };

  return (
    <Show
      when={accountDoc()}
      fallback={<div class="configurator loading">Loading configuration...</div>}
    >
      <div class="configurator">
        <h2 class="configurator-title">Frame Configurator</h2>

        <SingleSelect
          label="Frame Tool"
          value={accountDoc()!.frameToolId}
          onChange={(v) => {
            setField("frameToolId", v as any);
            setTimeout(() => window.location.reload(), 50);
          }}
          options={frameOptions()}
        />

        <SingleSelect
          label="Account Sidebar"
          value={accountDoc()!.accountSidebarToolId}
          onChange={(v) => setField("accountSidebarToolId", v as any)}
          options={sidebarOptions()}
        />

        <SingleSelect
          label="Context Sidebar"
          value={accountDoc()!.contextSidebarToolId}
          onChange={(v) => setField("contextSidebarToolId", v as any)}
          options={contextSidebarOptions()}
        />

        <SortableList
          label="Toolbar"
          values={accountDoc()!.documentToolbarToolIds}
          setValues={(next) => setArrayField("documentToolbarToolIds", next)}
          allOptions={documentToolbarOptions()}
        />

        <SortableList
          label="Context Tools"
          values={accountDoc()!.contextToolIds}
          setValues={(next) => setArrayField("contextToolIds", next)}
          allOptions={contextToolOptions()}
        />
      </div>
    </Show>
  );
}

export function renderFrameConfigurator(
  handle: DocHandle<TinyPatchworkLayoutDoc>,
  element: ToolElement
) {
  const dispose = render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <FrameConfiguratorUI handle={handle} />
      </RepoContext.Provider>
    ),
    element
  );
  return () => dispose();
}

export { FrameConfiguratorUI as FrameConfigurator };
