import { ContextMenu } from "@kobalte/core/context-menu";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import {
  useSupportedToolsForType,
  useFilteredDatatypes,
} from "../lib/solid-plugins";
import type {
  DatatypeDescription,
  Plugin,
} from "@inkandswitch/patchwork-plugins";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";
import {
  type SideboardDragAndDropItem,
  dragstack,
  addToDragstack,
  removeFromDragstack,
  clearDragstack,
  setDragging,
  setDragSourceItems,
  clearDragSourceItems,
  getDropTarget,
  setDropTarget,
  isAbove,
  clearDropTarget,
  copyMode,
  setCopyMode,
  isNewDocDrag,
  setDragOriginView,
  isSameDragOriginView,
} from "../dnd/dnd.ts";
import { setPendingNewDoc } from "../state.ts";
import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import {
  type FolderDoc,
  getImportableUrlFromAutomergeUrl,
} from "@inkandswitch/patchwork-filesystem";
import { executeDrop, removeItemsByUrl } from "../dnd/operations.ts";
import { getDndPayload } from "../dnd/payload.ts";
import { handleFilesDrop } from "./file-drop.ts";
import { log } from "../dnd/debug.ts";

// ── OS drag-out ─────────────────────────────────────────────────────────────
// A best-effort extension→MIME map so a single dragged `file` doc can be exposed
// as a real OS file via the Chromium `DownloadURL` format. The bytes are served
// (with the doc's stored mime) by the patchwork service worker; the OS keys off
// the filename extension, so this hint only needs to be reasonable. Duplicated
// on purpose for now — a shared DnD package is a later step.
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
};

function mimeForName(name: string): string | undefined {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ext ? EXT_MIME[ext] : undefined;
}

export default function Item(props: {
  "aria-label": string;
  id: string;
  url: AutomergeUrl;
  name: string;
  type: string;
  pressed: boolean;
  children: JSX.Element;
  openWith(toolId?: string): void;
  startRenaming(): void;
  remove(): void;
  share?(): void;
  shareDisabled?: boolean;
  makeSecureCopy?(): void;
  element: PatchworkViewElement;
  repo: Repo;
  rootFolderHandle: DocHandle<FolderDoc>;
  parentFolderHandle?: DocHandle<FolderDoc>;
  itemIndex?: number;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /** when set (i.e. this item is a folder), enables a "Create" submenu that
   * makes a new doc of the picked datatype inside this folder */
  createInside?(datatype: Plugin<DatatypeDescription>): void;
}) {
  const tools = useSupportedToolsForType(props.type);
  const datatypes = useFilteredDatatypes((item) => !item.unlisted);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();

  // Metadata for OS drag-out, prefetched (once, on mouse-down) for `file` docs
  // so dragstart can synchronously expose an accurate `DownloadURL`. If the doc
  // hasn't resolved yet we fall back to the DocLink name + extension-derived
  // mime, which is good enough (the OS keys off the filename extension anyway).
  const [fileMeta, setFileMeta] = createSignal<{
    mime: string;
    filename: string;
  } | null>(null);
  let filePrefetched = false;
  function prefetchFileMeta() {
    if (filePrefetched || props.type !== "file") return;
    filePrefetched = true;
    props.repo
      .find(props.url)
      .then((handle) => {
        const doc = handle?.doc() as
          | { name?: string; extension?: string; mimeType?: string }
          | undefined;
        if (!doc) return;
        const base = String(doc.name ?? props.name ?? "file");
        const ext = doc.extension
          ? `.${String(doc.extension).replace(/^\.+/, "")}`
          : "";
        const filename = ext && !base.endsWith(ext) ? `${base}${ext}` : base;
        const mime = String(
          doc.mimeType || mimeForName(filename) || "application/octet-stream"
        );
        setFileMeta({ mime, filename });
      })
      .catch(() => {});
  }

  createEffect((prev) => {
    if (props.pressed && !prev) {
      const el = untrack(trigger);
      if (el) {
        // @ts-expect-error scrollIntoViewIfNeeded is non-standard
        el?.scrollIntoViewIfNeeded?.();
      }
    }
    return props.pressed;
  });

  const dnd = (): SideboardDragAndDropItem => ({
    id: props.id,
    type: props.type,
    url: props.url,
    name: props.name,
    source: props.element.toolId!,
  });

  // Spring-loading: while a drag is in progress, hovering it over a document
  // row for a moment opens that document in the main view *without ending the
  // drag*, so you can then drop the payload at a precise spot inside the now-
  // open document. Mirrors the folder auto-expand-on-hover behaviour in
  // folder.tsx. Folders are excluded here (they auto-expand inline instead),
  // and the rows being dragged never spring-load themselves.
  const SPRING_LOAD_MS = 1500;
  let springTimer: ReturnType<typeof setTimeout> | null = null;
  let springCommitted = false;

  function startSpringLoad(target: HTMLElement) {
    if (props.type === "folder" || dragstack.has(props.id)) return;
    if (springTimer || springCommitted) return;

    target.setAttribute("data-dnd-springload", "");
    springTimer = setTimeout(() => {
      springTimer = null;
      springCommitted = true;
      target.removeAttribute("data-dnd-springload");
      props.openWith();
    }, SPRING_LOAD_MS);
  }

  function stopSpringLoad() {
    if (springTimer) {
      clearTimeout(springTimer);
      springTimer = null;
    }
    springCommitted = false;
    trigger()?.removeAttribute("data-dnd-springload");
  }

  onCleanup(stopSpringLoad);

  // Remove from the context menu. When this item is part of a multi-selection
  // (cmd-click or cmd-drag marquee), remove the whole selection — with a
  // confirmation prompt, since removing several at once is easy to fat-finger.
  // A lone item removes without a prompt, matching the old behaviour.
  async function handleRemove() {
    const multi = dragstack.has(props.id) && dragstack.size > 1;
    if (!multi) {
      props.remove();
      return;
    }
    const urls = [...dragstack.values()].map((item) => item.url);
    if (!confirm(`Remove ${urls.length} items from the sidebar?`)) return;
    clearDragstack();
    await removeItemsByUrl(props.repo, props.rootFolderHandle, urls);
  }

  async function handleDrop(
    event: DragEvent,
    targetId: string,
    position: "above" | "below" | "inside"
  ) {
    log("Item drop handler called for:", targetId, position);

    // Handle file drops from OS. Above/below go into this item's parent; inside
    // goes into the target folder itself.
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      const folderHandle =
        position === "inside" && props.type === "folder"
          ? await props.repo.find<FolderDoc>(props.url)
          : (props.parentFolderHandle ?? props.rootFolderHandle);

      await handleFilesDrop(
        event.dataTransfer.files,
        folderHandle,
        props.repo,
        position,
        position === "inside" ? 0 : (props.itemIndex ?? 0)
      );
      return;
    }

    const payload = getDndPayload(event);
    if (!payload) {
      log("No dnd data in drop event. types:", event.dataTransfer?.types);
      return;
    }

    const { source, items } = payload;
    log("Drop data:", { source, items, targetId, position });

    executeDrop(
      {
        draggedIds: items.map((i: any) => i.id),
        draggedUrls: items.map((i: any) => i.url),
        draggedItems: items,
        targetId,
        position,
        sourceToolId: source,
        copyMode: copyMode(),
      },
      props.repo,
      props.rootFolderHandle,
      isSameDragOriginView(props.element)
    );
  }

  return (
    <ContextMenu>
      <ContextMenu.Trigger
        ref={setTrigger}
        ondragstart={(event: DragEvent) => {
          if (!dragstack.has(props.id)) {
            clearDragstack();
            addToDragstack(props.id, dnd());
          }

          const items = dragstack.values();

          const urls = [];
          const ids = [];

          // Check for Alt key for copy mode
          setCopyMode(event.altKey);
          // "all" so the drag advertises copy, move, AND link. Every sideboard
          // drop is a link at the automerge level (same url, no doc cloned), and
          // link is also what lets Chrome offer split-view when dragging out.
          // Internal dragover handlers still set dropEffect to copy/move, which
          // stay valid as a subset of "all".
          event.dataTransfer!.effectAllowed = "all";

          for (const item of items) {
            urls.push(item.url);
            ids.push(item.id);
          }

          const urlList =
            urls
              .map(
                (url) =>
                  location.protocol +
                  "//" +
                  location.host +
                  `/#doc=${parseAutomergeUrl(url).documentId}`
              )
              .join("\r\n") + "\r\n";

          // Expose a real URL list so the browser treats the drag as a link —
          // this is what enables Chrome's split-view when dragging a doc out of
          // the app. Our own drop targets prefer text/x-patchwork-dnd, so this
          // doesn't change in-app behaviour.
          event.dataTransfer?.items.add(urlList, "text/uri-list");
          // Keep custom types for our internal DnD system
          event.dataTransfer?.items.add(
            JSON.stringify(ids),
            "text/x-sideboard-ids"
          );
          event.dataTransfer?.items.add(
            JSON.stringify(urls),
            "text/x-patchwork-urls"
          );

          // Add structured data with source tracking. The move-vs-copy decision
          // keys off the origin *element* (setDragOriginView below), not this
          // toolId, which is null for the fallback-mounted sideboard.
          event.dataTransfer?.items.add(
            JSON.stringify({
              source: props.element.toolId,
              items: [...dragstack.values()],
            }),
            "text/x-patchwork-dnd"
          );

          // OS drag-out: a single `file` doc can be dragged straight to the
          // desktop/Finder as a real file (Chromium `DownloadURL`). Served as
          // raw content by the patchwork service worker at `/<encoded url>/`.
          // Single-item only — the format carries one entry.
          if (dragstack.size === 1 && props.type === "file") {
            const meta = fileMeta();
            const filename = meta?.filename ?? props.name;
            const mime =
              meta?.mime ?? mimeForName(filename) ?? "application/octet-stream";
            try {
              const swUrl = new URL(
                getImportableUrlFromAutomergeUrl(props.url),
                location.origin
              ).href;
              event.dataTransfer?.setData(
                "DownloadURL",
                `${mime}:${filename}:${swUrl}`
              );
            } catch {
              // location unavailable in exotic embeds — skip OS export.
            }
          }

          // Create drag preview
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
          const count = dragstack.size;
          const modeText = event.altKey ? " (copy)" : "";
          preview.textContent =
            count === 1 ? props.name + modeText : `${count} items${modeText}`;
          document.body.appendChild(preview);
          event.dataTransfer!.setDragImage(preview, 10, 10);

          // Clean up after drag
          setTimeout(() => preview.remove(), 0);

          setDragSourceItems([...dragstack.keys()]);
          setDragOriginView(props.element);
          setDragging(true);
        }}
        ondrag={(event: DragEvent) => {
          // Update copy mode if Alt key state changes during drag
          if (event.altKey !== copyMode()) {
            setCopyMode(event.altKey);
          }
        }}
        ondragend={(event: DragEvent) => {
          stopSpringLoad();
          clearDragSourceItems();
          clearDragstack();
          setCopyMode(false);
          setDragOriginView(null);
          setDragging(false);
        }}
        ondragover={(event: DragEvent) => {
          event.preventDefault();

          // Update drop effect based on copy mode
          event.dataTransfer!.dropEffect = copyMode() ? "copy" : "move";

          // Determine drop position
          let position: "above" | "below" | "inside";

          if (props.type === "folder") {
            // For folders, use three zones: top 25% = above, bottom 25% = below, middle = inside
            const rect = (
              event.currentTarget as Element
            ).getBoundingClientRect();
            const offset = event.clientY - rect.top;
            const relativePosition = offset / rect.height;

            if (relativePosition < 0.25) {
              position = "above";
            } else if (relativePosition > 0.75) {
              position = "below";
            } else {
              position = "inside";
            }

            // Only bubble to container for "inside" drops
            if (position !== "inside") {
              event.stopPropagation();
            }
          } else {
            // For non-folders, just above or below
            position = isAbove(event.clientY, event.currentTarget as Element)
              ? "above"
              : "below";
            event.stopPropagation();
          }

          setDropTarget({ id: props.id, position });

          startSpringLoad(event.currentTarget as HTMLElement);
        }}
        ondragleave={(event: DragEvent) => {
          // Only clear if we're actually leaving (not entering a child)
          const related = event.relatedTarget as Element;
          if (!related || !(event.currentTarget as Element).contains(related)) {
            stopSpringLoad();
            clearDropTarget();
          }
        }}
        ondrop={(event: DragEvent) => {
          stopSpringLoad();
          const target = getDropTarget();
          console.log(
            "[DnD] Item ondrop event fired",
            props.id,
            "type:",
            props.type,
            "target:",
            target
          );

          // For folder rows, handle "inside" directly. Relying on bubbling from
          // the row button to the folder wrapper is fragile and can make a
          // folder-name drop do nothing in some browsers/components.
          if (props.type === "folder" && target?.position === "inside") {
            event.preventDefault();
            event.stopPropagation();

            if (isNewDocDrag(event)) {
              setPendingNewDoc({
                containerUrl: props.url,
                index: 0,
              });
              clearDropTarget();
              return;
            }

            handleDrop(event, target.id, "inside");
            clearDropTarget();
            return;
          }

          log("Item handling drop itself");
          event.preventDefault();
          event.stopPropagation();

          if (!target) {
            log("No drop target set");
            return;
          }

          // New-doc drag: open a pending placeholder next to this item instead
          // of moving a document.
          if (isNewDocDrag(event)) {
            if (props.parentFolderHandle && props.itemIndex != null) {
              const index =
                target.position === "above"
                  ? props.itemIndex
                  : props.itemIndex + 1;
              setPendingNewDoc({
                containerUrl: props.parentFolderHandle.url,
                index,
              });
            }
            clearDropTarget();
            return;
          }

          handleDrop(event, target.id, target.position as "above" | "below");
          clearDropTarget();
        }}
        draggable
        data-dnd-item={props.id}
        data-doc-url={props.url}
        data-doc-type={props.type}
        aria-label={props["aria-label"]}
        aria-haspopup="menu"
        as="button"
        class="popmenu__trigger document-list-item"
        role="treeitem"
        aria-selected={props.pressed ? "true" : undefined}
        onMouseDown={(event: MouseEvent) => {
          // Warm up file metadata so a subsequent drag can export to the OS.
          prefetchFileMeta();
          if (event.ctrlKey || event.metaKey) {
            if (dragstack.has(props.id)) {
              removeFromDragstack(props.id);
            } else {
              addToDragstack(props.id, dnd());
            }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
          } else if (!dragstack.has(props.id)) {
            clearDragstack();
          }
        }}
        on:click={(event: MouseEvent) => {
          if (event.ctrlKey || event.metaKey) {
            return;
          }
          const target = event.target as Element;
          if (
            target.closest(".document-list-folder__toggle, .create-new-button")
          ) {
            return;
          }
          clearDragstack();
          props.openWith();
        }}
        on:dblclick={() => {
          props.startRenaming();
        }}
        onkeydown={(event: KeyboardEvent) => {
          // Arrow key navigation
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const current = event.currentTarget as HTMLElement;
            const allItems = Array.from(
              document.querySelectorAll("[data-dnd-item]")
            ).filter(
              (item) => (item as HTMLElement).offsetParent !== null
            ) as HTMLElement[];
            const currentIndex = allItems.indexOf(current);

            if (
              event.key === "ArrowDown" &&
              currentIndex < allItems.length - 1
            ) {
              allItems[currentIndex + 1]?.focus();
            } else if (event.key === "ArrowUp" && currentIndex > 0) {
              allItems[currentIndex - 1]?.focus();
            }
            return;
          }

          // Left/Right for folder expand/collapse
          if (props.type === "folder" && props.onToggleExpand) {
            if (event.key === "ArrowRight" && !props.isExpanded) {
              event.preventDefault();
              props.onToggleExpand();
              return;
            } else if (event.key === "ArrowLeft" && props.isExpanded) {
              event.preventDefault();
              props.onToggleExpand();
              return;
            }
          }

          // Context menu shortcut
          if (
            event.key == "Enter" &&
            event.ctrlKey &&
            !(+event.altKey | +event.shiftKey | +event.metaKey)
          ) {
            if (trigger()) {
              event.preventDefault();
              event.stopImmediatePropagation();
              event.stopPropagation();
              const el = event.target as HTMLButtonElement;
              const box = el.getBoundingClientRect();
              trigger()!.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  clientX: box.x + 10,
                  clientY: box.y + box.height - 10,
                })
              );
            }
          }
        }}
      >
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content class="popmenu__content">
          <Show when={props.createInside}>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger class="popmenu__sub-trigger">
                Create
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent class="popmenu__sub-content">
                  <For each={datatypes}>
                    {(datatype) => (
                      <ContextMenu.Item
                        class="popmenu__item"
                        onSelect={() => props.createInside!(datatype)}
                      >
                        {datatype.name}
                      </ContextMenu.Item>
                    )}
                  </For>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          </Show>
          <Show when={tools.length}>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger class="popmenu__sub-trigger">
                Open with...
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent class="popmenu__sub-content">
                  <For each={tools}>
                    {(tool) => {
                      return (
                        <ContextMenu.Item
                          class="popmenu__item"
                          onSelect={() => props.openWith(tool.id)}
                        >
                          {tool.name}
                        </ContextMenu.Item>
                      );
                    }}
                  </For>
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          </Show>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger class="popmenu__sub-trigger">
              Copy
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent class="popmenu__sub-content">
                <ContextMenu.Item
                  class="popmenu__item"
                  onSelect={() => navigator.clipboard.writeText(props.url)}
                >
                  Automerge url
                </ContextMenu.Item>
                <ContextMenu.Item
                  class="popmenu__item"
                  onSelect={() =>
                    navigator.clipboard.writeText(
                      `${location.protocol}//${location.host}/#doc=${parseAutomergeUrl(props.url).documentId}`
                    )
                  }
                >
                  Patchwork url
                </ContextMenu.Item>
                <Show when={tools.length}>
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger class="popmenu__sub-trigger">
                      Patchwork url with...
                    </ContextMenu.SubTrigger>
                    <ContextMenu.Portal>
                      <ContextMenu.SubContent class="popmenu__sub-content">
                        <For each={tools}>
                          {(tool) => (
                            <ContextMenu.Item
                              class="popmenu__item"
                              onSelect={() =>
                                navigator.clipboard.writeText(
                                  `${location.protocol}//${location.host}/#doc=${parseAutomergeUrl(props.url).documentId}&tool=${tool.id}`
                                )
                              }
                            >
                              {tool.name}
                            </ContextMenu.Item>
                          )}
                        </For>
                      </ContextMenu.SubContent>
                    </ContextMenu.Portal>
                  </ContextMenu.Sub>
                </Show>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            class="popmenu__item"
            onSelect={() => props.startRenaming()}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item
            class="popmenu__item"
            onSelect={() => handleRemove()}
          >
            {dragstack.has(props.id) && dragstack.size > 1
              ? `Remove ${dragstack.size} items`
              : "Remove"}
          </ContextMenu.Item>
          <Show when={props.share}>
            <ContextMenu.Item
              class="popmenu__item"
              onSelect={() => props.share?.()}
              disabled={props.shareDisabled}
            >
              Share
            </ContextMenu.Item>
          </Show>
          <Show when={props.makeSecureCopy}>
            <ContextMenu.Item
              class="popmenu__item"
              onSelect={() => props.makeSecureCopy?.()}
            >
              Duplicate (unshared)
            </ContextMenu.Item>
          </Show>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  );
}
