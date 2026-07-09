import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type ChangeFn,
  type Repo,
} from "@automerge/automerge-repo";
import {
  type DatatypeDescription,
  type Plugin,
  createDocOfDatatype2,
  getRegistry,
  isLoadablePlugin,
  isLoadedPlugin,
} from "@inkandswitch/patchwork-plugins";
import { createSignal, For, Show } from "solid-js";
import { NewDocIcon } from "./icons.tsx";
import type { DocLink, FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { docLinkFromUrl } from "./lib/doc-link.ts";
import { useFilteredDatatypes } from "./lib/solid-plugins";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";
import type { LegacyAutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { NEW_DOC_DND_TYPE, setNewDocDragging, clearDropTarget } from "./dnd/dnd.ts";

export async function createNew(
  repo: Repo,
  datatype: Plugin<DatatypeDescription>,
  hive?: LegacyAutomergeRepoKeyhive
): Promise<DocLink> {
  if (isLoadablePlugin(datatype)) {
    const registry = getRegistry("patchwork:datatype");
    await registry.load(datatype.id);
  }
  if (!isLoadedPlugin(datatype)) {
    throw new Error("plugin not loaded after loading");
  }

  const docHandle = await createDocOfDatatype2(datatype, repo);
  if (hive) {
    // A failure here means the doc will not sync until relay access is granted,
    // but the doc itself is usable, so do not fail the whole creation.
    try {
      await hive.addSyncServerRelayToDoc(docHandle.url);
    } catch (error) {
      console.warn(
        `createNew: could not grant sync-server relay access for ${docHandle.url}`,
        error
      );
    }
  }
  const doc = docHandle.doc();
  const name = datatype.module.getTitle(doc);

  return {
    name,
    type: datatype.id,
    url: docHandle.url,
  };
}

/**
 * The contents of the create-new dropdown: a filter input (also accepts a pasted
 * automerge url) and the list of datatypes. Rendered inside a <DropdownMenu> so
 * it can be reused by the toolbar button and the drag-created placeholder.
 */
function DatatypeMenuContent(props: {
  onPickDatatype(datatype: Plugin<DatatypeDescription>): void;
  onSubmitUrl(url: string): void;
}) {
  const datatypes = useFilteredDatatypes((item) => !item.unlisted);
  const [query, setQuery] = createSignal("");
  const [highlightIndex, setHighlightIndex] = createSignal(0);

  const isUrl = () => isValidAutomergeUrl(query().trim());

  const filteredDatatypes = () => {
    const q = query().toLowerCase();
    if (!q) return datatypes;
    return datatypes.filter((d) => d.name.toLowerCase().includes(q));
  };

  // total number of selectable items (url item + datatypes)
  const itemCount = () => (isUrl() ? 1 : 0) + filteredDatatypes().length;

  function selectHighlighted() {
    const idx = highlightIndex();
    if (isUrl()) {
      if (idx === 0) {
        props.onSubmitUrl(query());
        return;
      }
      // offset by 1 for the url item
      const datatype = filteredDatatypes()[idx - 1];
      if (datatype) props.onPickDatatype(datatype);
    } else {
      const datatype = filteredDatatypes()[idx];
      if (datatype) props.onPickDatatype(datatype);
    }
  }

  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="popmenu__content create-new-menu__content">
        <div class="create-new-filter">
          <input
            class="create-new-filter__input"
            placeholder="Filter or paste automerge url…"
            value={query()}
            onInput={(e) => {
              setQuery(e.target.value);
              setHighlightIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                selectHighlighted();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIndex((i) => Math.min(i + 1, itemCount() - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Escape") {
                // let the menu handle escape to close
                return;
              }
              // prevent the menu from handling other keys
              e.stopPropagation();
            }}
            onPaste={(e) => {
              // Pasting an automerge url should *offer* to add it (revealing the
              // "Add by URL" item) rather than silently adding it. Drop the
              // pasted text into the query; isUrl() then shows the button.
              const text = e.clipboardData?.getData("text/plain") ?? "";
              if (isValidAutomergeUrl(text.trim())) {
                e.preventDefault();
                setQuery(text.trim());
                setHighlightIndex(0);
              }
            }}
            ref={(el) => {
              requestAnimationFrame(() => el.focus());
            }}
          />
        </div>
        <Show when={isUrl()}>
          <DropdownMenu.Item
            class="popmenu__item"
            classList={{
              "popmenu__item--highlighted": highlightIndex() === 0,
            }}
            onSelect={() => props.onSubmitUrl(query())}
            onPointerMove={() => setHighlightIndex(0)}
          >
            Add by URL
          </DropdownMenu.Item>
        </Show>
        <For each={filteredDatatypes()}>
          {(datatype, i) => (
            <DropdownMenu.Item
              class="popmenu__item"
              classList={{
                "popmenu__item--highlighted":
                  highlightIndex() === i() + (isUrl() ? 1 : 0),
              }}
              onSelect={() => props.onPickDatatype(datatype)}
              onPointerMove={() => setHighlightIndex(i() + (isUrl() ? 1 : 0))}
            >
              {datatype.name}
            </DropdownMenu.Item>
          )}
        </For>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export interface CreateNewProps {
  repo: Repo;
  hive?: LegacyAutomergeRepoKeyhive;
  changeFolder(fn: ChangeFn<FolderDoc>): void;
  open(detail: OpenDocumentEventDetail): void;
  context?: string;
  /** render as a square, icon-only button (e.g. in the doclist toolbar) */
  square?: boolean;
  /** allow dragging the button onto a folder/item to create a doc there */
  draggable?: boolean;
  clearFilter(): void;
}

export default function CreateNew(props: CreateNewProps) {
  const [open, setOpen] = createSignal(false);

  async function selectDatatype(datatype: Plugin<DatatypeDescription>) {
    const freshy = await createNew(props.repo, datatype, props.hive);
    props.changeFolder((doc) => {
      doc.docs.push(freshy);
    });
    // Clear the filter so the just-created doc is actually visible in the list.
    props.clearFilter();
    props.open(freshy);
    setOpen(false);
  }

  async function handleUrlSubmit(url: string) {
    const trimmed = url.trim();
    if (!isValidAutomergeUrl(trimmed)) return;
    const docLink = await docLinkFromUrl(props.repo, trimmed as AutomergeUrl);
    props.changeFolder((doc) => {
      doc.docs.push(docLink);
    });
    // Clear the filter so the freshly added doc is visible.
    props.clearFilter();
    props.open(docLink);
    setOpen(false);
  }

  // Kobalte's menu trigger opens on pointerdown, which swallows the start of a
  // native drag. So the visible button is a plain draggable <button> that we
  // open the menu from on click; a 0-size aria-hidden trigger overlapping it
  // serves only as the dropdown's anchor.
  //
  // Kobalte's interact-outside listener closes the menu on a capture-phase
  // pointerdown (before our click fires), so a click on the open button closes
  // it. Guarding the click against a just-happened close keeps that click from
  // immediately re-opening it.
  let lastCloseAt = 0;

  function handleDragStart(event: DragEvent) {
    setOpen(false);
    setNewDocDragging(true);
    event.dataTransfer!.setData(NEW_DOC_DND_TYPE, "1");
    // "all" keeps move/copy dropEffects (set by the list's dragover handlers)
    // valid so the drop event actually fires.
    event.dataTransfer!.effectAllowed = "all";

    const preview = document.createElement("div");
    preview.style.cssText = `
      position: absolute;
      top: -1000px;
      background: var(--document-list-primary);
      padding: 0.5rem 0.75rem;
      border-radius: var(--document-list-radius);
      font-family: inherit;
      font-size: 0.9rem;
      pointer-events: none;
      color: var(--document-list-primary-line);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    `;
    preview.textContent = "new doc";
    document.body.appendChild(preview);
    event.dataTransfer!.setDragImage(preview, 10, 10);
    setTimeout(() => preview.remove(), 0);
  }

  return (
    <DropdownMenu
      open={open()}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) lastCloseAt = performance.now();
      }}
    >
      <div class="create-new-button-anchor">
        <button
          type="button"
          class="create-new-button"
          classList={{ "create-new-button--square": props.square }}
          aria-label="create new"
          draggable={props.draggable}
          onClick={() => {
            // skip the click that immediately follows an outside-close
            if (performance.now() - lastCloseAt > 200) setOpen(true);
          }}
          on:dragstart={props.draggable ? handleDragStart : undefined}
          on:dragend={() => {
            setNewDocDragging(false);
            clearDropTarget();
          }}
        >
          <NewDocIcon class="create-new-button__icon" />
          <Show when={!props.square}>
            {" "}
            <span class="create-new-button__text">Create new</span>
          </Show>
        </button>
        <DropdownMenu.Trigger
          class="create-new-button-anchor__trigger"
          aria-hidden="true"
          tabindex={-1}
        />
      </div>
      <DatatypeMenuContent
        onPickDatatype={selectDatatype}
        onSubmitUrl={handleUrlSubmit}
      />
    </DropdownMenu>
  );
}

/**
 * A pending "…new doc…" row inserted at a drag-drop location. Auto-opens the
 * type picker anchored to itself; picking a type (or dismissing) is reported via
 * the callbacks so the owning DocumentList can insert the doc at the right index.
 */
export function NewDocPlaceholder(props: {
  repo: Repo;
  hive?: LegacyAutomergeRepoKeyhive;
  onCreate(docLink: DocLink): void;
  onDismiss(): void;
  clearFilter(): void;
}) {
  const [open, setOpen] = createSignal(true);

  async function pickDatatype(datatype: Plugin<DatatypeDescription>) {
    const freshy = await createNew(props.repo, datatype, props.hive);
    props.clearFilter();
    props.onCreate(freshy);
  }

  async function submitUrl(url: string) {
    const trimmed = url.trim();
    if (!isValidAutomergeUrl(trimmed)) return;
    const docLink = await docLinkFromUrl(props.repo, trimmed as AutomergeUrl);
    props.clearFilter();
    props.onCreate(docLink);
  }

  return (
    <DropdownMenu
      open={open()}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) props.onDismiss();
      }}
      placement="bottom-start"
      flip={false}
    >
      <DropdownMenu.Trigger class="document-list-item document-list-placeholder">
        <span class="document-list-item__name">New document</span>
      </DropdownMenu.Trigger>
      <DatatypeMenuContent
        onPickDatatype={pickDatatype}
        onSubmitUrl={submitUrl}
      />
    </DropdownMenu>
  );
}
