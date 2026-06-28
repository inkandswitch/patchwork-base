import {
  updateText,
  type AutomergeUrl,
  type Repo,
  type DocHandle,
} from "@automerge/automerge-repo";
import type { AutomergeRepoKeyhive } from "@automerge/automerge-repo-keyhive";
import { useDocument } from "@automerge/automerge-repo-solid-primitives";
import type {
  OpenDocumentEventDetail,
  PatchworkViewElement,
} from "@inkandswitch/patchwork-elements";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import { handleFilesDrop } from "./file-drop.ts";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { filter, filterMatches, setRenaming, setPendingNewDoc } from "../state.ts";
import { DocumentList } from "./document-list.tsx";
import Item from "./item.tsx";
import { ItemName } from "./name.tsx";
import { createNew } from "../create-new.tsx";
import type {
  DatatypeDescription,
  Plugin,
} from "@inkandswitch/patchwork-plugins";
import { Chevron } from "../icons.tsx";
import {
  getDropTarget,
  setDropTarget,
  clearDropTarget,
  copyMode,
  isNewDocDrag,
} from "../dnd/dnd.ts";
import { executeDrop } from "../dnd/operations.ts";
import { getDndPayload } from "../dnd/payload.ts";
import { log } from "../dnd/debug.ts";

export default function Folder(props: {
  url: AutomergeUrl;
  repo: Repo;
  depth?: number;
  removeFromParent(): void;
  open(detail: OpenDocumentEventDetail): void;
  name?: string;
  hive?: AutomergeRepoKeyhive;
  selectedDocUrls: AutomergeUrl[];
  visitedFolders?: Set<AutomergeUrl>;
  element: PatchworkViewElement;
  rootFolderHandle: DocHandle<FolderDoc>;
  parentFolderHandle?: DocHandle<FolderDoc>;
  itemIndex?: number;
}) {
  const [ref, setRef] = createSignal<HTMLElement>();
  const [expanded, setExpanded] = createSignal(false);

  const [folder, handle] = useDocument<FolderDoc>(() => props.url, props);

  // Create a new Set with the current folder URL to prevent circular references
  const nextVisitedFolders = new Set(props.visitedFolders ?? []);
  nextVisitedFolders.add(props.url);

  const depth = () => props.depth ?? 1;
  const depthStyle = () => ({ "--depth": depth() + 1 });
  const folderDepthStyle = () => ({ "--depth": depth() });

  createEffect((last) => {
    if (!last && filter() && filterMatches(folder()!?.title ?? props.name)) {
      setExpanded(true);
    }
    return filter();
  });

  // lol @ this huge hack
  onMount(() => {
    setTimeout(() => {
      const has = !!ref()?.querySelector(
        ".document-list-item[aria-selected='true']"
      );
      setExpanded((open) => open || has);
    }, 500);
  });

  // Auto-expand/collapse folders during drag hover.
  // 1s: toggle. 2s: commit (don't revert on leave). Requires re-entry after commit.
  // Auto-expand/collapse folders during drag hover.
  // After 1s hovering over this folder's header: toggle and commit.
  // Requires re-entry to trigger again.
  let dragToggleTimer: ReturnType<typeof setTimeout> | null = null;
  let dragAutoCommitted = false;

  function startDragAutoToggle() {
    if (dragToggleTimer || dragAutoCommitted) return;

    dragToggleTimer = setTimeout(() => {
      setExpanded((v) => !v);
      dragAutoCommitted = true;
      dragToggleTimer = null;
    }, 1000);
  }

  function stopDragAutoToggle() {
    if (dragToggleTimer) { clearTimeout(dragToggleTimer); dragToggleTimer = null; }
    dragAutoCommitted = false;
  }

  onCleanup(stopDragAutoToggle);

  function rename(name: string) {
    handle()?.change((doc) => updateText(doc, ["title"], name));
  }

  async function createInside(datatype: Plugin<DatatypeDescription>) {
    const h = handle();
    if (!h) return;
    const freshy = await createNew(props.repo, datatype, props.hive);
    let newIndex = 0;
    h.change((folder) => {
      folder.docs.push(freshy);
      newIndex = folder.docs.length - 1;
    });
    setExpanded(true);
    props.open(freshy);
    setRenaming(h.url + "/" + newIndex);
  }

  async function handleDropIntoFolder(
    event: DragEvent,
    folderUrl: AutomergeUrl
  ) {
    log("Folder drop handler called for:", folderUrl);

    // Handle file drops from OS - add to beginning of folder
    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      await handleFilesDrop(
        event.dataTransfer.files,
        handle()!,
        props.repo,
        "inside",
        0
      );
      return;
    }

    const payload = getDndPayload(event);
    if (!payload) {
      log("No dnd data in drop event. types:", event.dataTransfer?.types);
      return;
    }

    const { source, items } = payload;
    log("Drop data:", { source, items, folderUrl });

    executeDrop(
      {
        draggedIds: items.map((i: any) => i.id),
        draggedUrls: items.map((i: any) => i.url),
        draggedItems: items,
        targetId: folderUrl,
        position: "inside",
        sourceToolId: source,
        copyMode: copyMode(),
      },
      props.repo,
      props.rootFolderHandle,
      props.element.toolId!
    );
  }

  return (
    <div
      class="document-list-folder"
      role="group"
      data-depth={depth()}
      style={folderDepthStyle()}
      aria-expanded={expanded()}
      data-dnd-container={props.url}
      ondragover={(event: DragEvent) => {
        event.preventDefault();
        event.stopPropagation();

        // Update drop effect based on copy mode
        const effect = copyMode() ? "copy" : "move";
        event.dataTransfer!.dropEffect = effect;

        // Only set "inside" if we're not directly over an item element
        // (If we're over an item, it will set its own above/below/inside position)
        const target = event.target as Element;
        const isOverItem = target.closest(".document-list-item");

        if (!isOverItem) {
          // Dropping into folder empty space
          setDropTarget({ id: props.url, position: "inside" });
        }

        // Auto-toggle: only when hovering over THIS folder's header
        const overItem = (event.target as Element).closest(".document-list-item");
        if (overItem?.getAttribute("data-dnd-item") === props.url) {
          startDragAutoToggle();
        }
      }}
      ondragleave={(event: DragEvent) => {
        const related = event.relatedTarget as Element;
        if (!related || !(event.currentTarget as Element).contains(related)) {
          stopDragAutoToggle();
          clearDropTarget();
        }
      }}
      ondrop={(event: DragEvent) => {
        stopDragAutoToggle();
        log("Folder ondrop event fired", props.url);
        event.preventDefault();
        event.stopPropagation();

        // Check the drop position - only handle "inside" drops
        // (The item handles its own "above" and "below" drops)
        const target = getDropTarget();

        if (target?.position === "inside") {
          // New-doc drag: open a pending placeholder at the top of this folder
          // instead of moving a document into it. Expand the folder so the
          // placeholder is visible.
          if (isNewDocDrag(event)) {
            const h = handle();
            if (h) {
              setExpanded(true);
              setPendingNewDoc({ containerUrl: h.url, index: 0 });
            }
          } else {
            handleDropIntoFolder(event, props.url);
          }
        }
        clearDropTarget();
      }}
    >
      <Item
        aria-label={folder()?.title ?? props.name ?? ""}
        startRenaming={() => {
          setRenaming(props.url);
        }}
        remove={props.removeFromParent}
        id={props.url}
        url={props.url}
        name={folder()?.title ?? props.name ?? ""}
        pressed={props.selectedDocUrls.includes(props.url)}
        type="folder"
        element={props.element}
        repo={props.repo}
        rootFolderHandle={props.rootFolderHandle}
        parentFolderHandle={props.parentFolderHandle}
        itemIndex={props.itemIndex}
        isExpanded={expanded()}
        onToggleExpand={() => setExpanded((yn) => !yn)}
        createInside={createInside}
        openWith={(toolId) => {
          props.open({
            url: props.url,
            toolId,
            title: folder()?.title ?? props.name,
            type: "folder",
          });
        }}
      >
        <button
          aria-label={
            (expanded() ? "collapse" : "expand") +
            " " +
            (folder()?.title ?? props.name)
          }
          class="document-list-folder__toggle"
          on:click={(event: MouseEvent) => {
            event.stopImmediatePropagation();
            setExpanded((yn) => !yn);
          }}
        >
          <Show when={expanded()} fallback={<Chevron />}>
            <Chevron style={{ rotate: "90deg" }} />
          </Show>
        </button>
        <ItemName
          name={folder()?.title ?? props.name}
          id={props.url}
          rename={rename}
        />
      </Item>

      <div
        ref={(el) => setRef(el)}
        class="document-list-folder__contents"
        classList={{ "document-list-folder__contents--hidden": !expanded() && !filter() }}
        data-depth={depth()}
        style={depthStyle()}
      >
        <DocumentList
          docs={folder()?.docs}
          repo={props.repo}
          depth={depth() + 1}
          handle={handle.latest!}
          open={props.open}
          hive={props.hive}
          selectedDocUrls={props.selectedDocUrls}
          visitedFolders={nextVisitedFolders}
          element={props.element}
          rootFolderHandle={props.rootFolderHandle}
        />
      </div>
    </div>
  );
}
