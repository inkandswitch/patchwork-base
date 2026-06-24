import "./styles.css";
import type { DocHandle } from "@automerge/automerge-repo";
import type { ToolElement, ToolDescription } from "@inkandswitch/patchwork-plugins";
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
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

/* ── Shared icons ── */

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

const CloseIcon = (props: { size?: number }) => {
  const s = () => props.size ?? 10;
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
    >
      <line x1="2" y1="2" x2="8" y2="8" />
      <line x1="8" y1="2" x2="2" y2="8" />
    </svg>
  );
};

const CheckIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <polyline points="2.5 6 5 8.5 9.5 3.5" />
  </svg>
);

/* ── Add Popover (shared by toolbar + context tabs) ── */

function AddPopover(props: {
  available: ModuleOption[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [customId, setCustomId] = createSignal("");

  const addCustom = () => {
    const id = customId().trim();
    if (!id) return;
    props.onAdd(id);
    setCustomId("");
  };

  return (
    <div class="add-popover">
      <For each={props.available}>
        {(opt) => (
          <button class="add-popover-option" onClick={() => props.onAdd(opt.id)}>
            <PlusIcon />
            {opt.name}
          </button>
        )}
      </For>
      <div class="add-popover-custom">
        <input
          type="text"
          class="add-popover-custom-input"
          placeholder="tool-id"
          value={customId()}
          onInput={(e) => setCustomId(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
        />
        <button
          class="add-popover-custom-btn"
          onClick={addCustom}
          disabled={!customId().trim()}
        >
          <PlusIcon />
        </button>
      </div>
      <button class="add-popover-done" onClick={() => props.onClose()}>
        Done
      </button>
    </div>
  );
}

/* ── Null selected-doc boundary ── */

/**
 * Intercepts patchwork:subscribe events for selected-doc / selected-view
 * and responds with empty values, preventing descendant patchwork-views
 * from picking up the real selection (which would cause the frame
 * configurator to infinitely render itself).
 */
function nullSelectedDocRef(el: HTMLElement) {
  el.addEventListener("patchwork:subscribe", ((event: SubscribeEvent) => {
    if (event.detail.selector.type === "patchwork:selected-doc") {
      accept<string[]>(event, (respond) => {
        respond([]);
      });
    } else if (event.detail.selector.type === "patchwork:selected-view") {
      accept<null>(event, (respond) => {
        respond(null);
      });
    }
  }) as EventListener, true);
}

/* ── Preview Card Grid (frame / sidebar single-select) ── */

function PreviewCardGrid(props: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  options: ModuleOption[];
  docUrl: string;
}) {
  return (
    <div class="config-section">
      <div class="section-label">{props.label}</div>
      <Show
        when={props.options.length > 0}
        fallback={<p class="empty-message">No tools available</p>}
      >
        <div class="preview-grid" ref={nullSelectedDocRef}>
          <For each={props.options}>
            {(opt) => (
              <button
                class="preview-card"
                aria-checked={props.value === opt.id}
                onClick={() => props.onChange(opt.id)}
              >
                <div class="preview-card-thumbnail">
                  <div class="preview-card-scaler">
                    <patchwork-view
                      doc-url={props.docUrl}
                      tool-id={opt.id}
                    />
                  </div>
                </div>
                <div class="preview-card-label">
                  <span>{opt.name}</span>
                  <span class="preview-card-check">
                    <CheckIcon />
                  </span>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/* ── Drag helpers ── */

function itemDragClass(
  i: number,
  dragFrom: number | null,
  dropTo: number | null
): string {
  if (dragFrom === null || dropTo === null) return "";
  if (i === dragFrom) return " dragging";
  if (dropTo === dragFrom) return "";
  // Items between source and target shift to make room
  if (dragFrom < dropTo && i > dragFrom && i <= dropTo) return " shift-left";
  if (dragFrom > dropTo && i < dragFrom && i >= dropTo) return " shift-right";
  return "";
}

function ToolbarStrip(props: {
  label: string;
  values: string[] | undefined;
  setValues: (next: string[]) => void;
  allOptions: ModuleOption[];
  docUrl: string;
}) {
  const [showAdd, setShowAdd] = createSignal(false);
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);
  let lastDropIndex: number | null = null;

  const currentIds = createMemo(() => new Set(props.values ?? []));
  const available = createMemo(() =>
    props.allOptions.filter((o) => !currentIds().has(o.id))
  );
  const nameOf = (id: string) =>
    props.allOptions.find((o) => o.id === id)?.name ?? id;

  const removeAt = (index: number) => {
    const vals = props.values;
    if (!vals) return;
    props.setValues(vals.filter((_, i) => i !== index));
  };

  const add = (id: string) => {
    props.setValues([...(props.values ?? []), id]);
  };

  const updateDropIndex = (i: number) => {
    lastDropIndex = i;
    setDropIndex(i);
  };

  const handleDragEnd = () => {
    const from = dragIndex();
    const to = lastDropIndex;
    setDragIndex(null);
    setDropIndex(null);
    lastDropIndex = null;
    if (from == null || to == null || from === to) return;
    const arr = [...(props.values ?? [])];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    props.setValues(arr);
  };

  return (
    <div class="config-section">
      <div class="section-label">{props.label}</div>
      <div
        class={`toolbar-strip${dragIndex() !== null ? " is-dragging" : ""}`}
        ref={nullSelectedDocRef}
      >
        <For each={props.values ?? []}>
          {(id, index) => (
            <div
              class={`toolbar-box${itemDragClass(index(), dragIndex(), dropIndex())}`}
              draggable={true}
              onDragStart={(e) => {
                e.dataTransfer!.effectAllowed = "move";
                const idx = index();
                requestAnimationFrame(() => {
                  setDragIndex(idx);
                  updateDropIndex(idx);
                });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer!.dropEffect = "move";
                updateDropIndex(index());
              }}
              onDragEnd={() => handleDragEnd()}
            >
              <div class="toolbar-box-preview">
                <patchwork-view
                  doc-url={props.docUrl}
                  tool-id={id}
                  style="pointer-events:none;width:100%;height:100%"
                />
              </div>
              <div class="toolbar-box-label">{nameOf(id)}</div>
              <button
                class="toolbar-box-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(index());
                }}
                aria-label={`Remove ${nameOf(id)}`}
              >
                <CloseIcon size={8} />
              </button>
            </div>
          )}
        </For>
        <div class="add-popover-anchor">
          <button
            class="toolbar-add-btn"
            onClick={() => setShowAdd(!showAdd())}
            aria-label="Add toolbar item"
          >
            <PlusIcon />
          </button>
          <Show when={showAdd()}>
            <AddPopover
              available={available()}
              onAdd={add}
              onClose={() => setShowAdd(false)}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}

/* ── Context Tabs ── */

function ContextTabs(props: {
  label: string;
  values: string[] | undefined;
  setValues: (next: string[]) => void;
  allOptions: ModuleOption[];
}) {
  const [showAdd, setShowAdd] = createSignal(false);
  const [dragIndex, setDragIndex] = createSignal<number | null>(null);
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);
  let lastDropIndex: number | null = null;

  const currentIds = createMemo(() => new Set(props.values ?? []));
  const available = createMemo(() =>
    props.allOptions.filter((o) => !currentIds().has(o.id))
  );
  const nameOf = (id: string) =>
    props.allOptions.find((o) => o.id === id)?.name ?? id;

  const removeAt = (index: number) => {
    const vals = props.values;
    if (!vals) return;
    props.setValues(vals.filter((_, i) => i !== index));
  };

  const add = (id: string) => {
    props.setValues([...(props.values ?? []), id]);
  };

  const updateDropIndex = (i: number) => {
    lastDropIndex = i;
    setDropIndex(i);
  };

  const handleDragEnd = () => {
    const from = dragIndex();
    const to = lastDropIndex;
    setDragIndex(null);
    setDropIndex(null);
    lastDropIndex = null;
    if (from == null || to == null || from === to) return;
    const arr = [...(props.values ?? [])];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    props.setValues(arr);
  };

  return (
    <div class="config-section">
      <div class="section-label">{props.label}</div>
      <div
        class={`context-tabs${dragIndex() !== null ? " is-dragging" : ""}`}
      >
        <For each={props.values ?? []}>
          {(id, index) => (
            <div
              class={`context-tab${itemDragClass(index(), dragIndex(), dropIndex())}`}
              draggable={true}
              onDragStart={(e) => {
                e.dataTransfer!.effectAllowed = "move";
                const idx = index();
                requestAnimationFrame(() => {
                  setDragIndex(idx);
                  updateDropIndex(idx);
                });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer!.dropEffect = "move";
                updateDropIndex(index());
              }}
              onDragEnd={() => handleDragEnd()}
            >
              <span>{nameOf(id)}</span>
              <button
                class="context-tab-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAt(index());
                }}
                aria-label={`Remove ${nameOf(id)}`}
              >
                <CloseIcon size={8} />
              </button>
            </div>
          )}
        </For>
        <div class="add-popover-anchor">
          <button
            class="context-tab-add"
            onClick={() => setShowAdd(!showAdd())}
          >
            <PlusIcon /> Add
          </button>
          <Show when={showAdd()}>
            <AddPopover
              available={available()}
              onAdd={add}
              onClose={() => setShowAdd(false)}
            />
          </Show>
        </div>
      </div>
    </div>
  );
}

/* ── Main UI ── */

function FrameConfiguratorUI(props: {
  handle: DocHandle<TinyPatchworkLayoutDoc>;
}) {
  const [accountDoc] = useDocument<TinyPatchworkLayoutDoc>(
    () => props.handle.url
  );

  const allTools = useToolDescriptions();

  const frameOptions = createMemo(() =>
    filterToolsByTag([...allTools], "frame-tool")
  );
  const sidebarOptions = createMemo(() =>
    filterToolsByTag([...allTools], "sidebar-account")
  );
  const documentToolbarOptions = createMemo(() =>
    filterToolsByTag([...allTools], "titlebar-tool")
  );
  const contextToolOptions = createMemo(() =>
    filterToolsByTag([...allTools], "context-tool")
  );

  const docUrl = props.handle.url;

  const setField = <K extends keyof TinyPatchworkLayoutDoc>(
    key: K,
    value: TinyPatchworkLayoutDoc[K]
  ) => {
    props.handle.change((doc: any) => {
      doc[key] = value as any;
    });
  };

  const setArrayField = (
    key: keyof TinyPatchworkLayoutDoc,
    next: string[]
  ) => {
    props.handle.change((doc: any) => {
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
        <PreviewCardGrid
          label="Frame Tool"
          value={accountDoc()!.frameToolId}
          onChange={(v) => {
            setField("frameToolId", v as any);
            setTimeout(() => window.location.reload(), 50);
          }}
          options={frameOptions()}
          docUrl={docUrl}
        />

        <PreviewCardGrid
          label="Account Sidebar"
          value={accountDoc()!.accountSidebarToolId}
          onChange={(v) => setField("accountSidebarToolId", v as any)}
          options={sidebarOptions()}
          docUrl={docUrl}
        />

        <ToolbarStrip
          label="Toolbar"
          values={accountDoc()!.documentToolbarToolIds}
          setValues={(next) => setArrayField("documentToolbarToolIds", next)}
          allOptions={documentToolbarOptions()}
          docUrl={docUrl}
        />

        <ContextTabs
          label="Context Tools"
          values={accountDoc()!.contextToolIds}
          setValues={(next) => setArrayField("contextToolIds", next)}
          allOptions={contextToolOptions()}
        />

        <Show when={(accountDoc() as any)?.themePreferencesUrl}>
          <div class="config-section">
            <div class="section-label">Theme</div>
            <div class="theme-embed">
              <patchwork-view
                doc-url={(accountDoc() as any).themePreferencesUrl}
                tool-id="theme-picker"
              />
            </div>
          </div>
        </Show>
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
