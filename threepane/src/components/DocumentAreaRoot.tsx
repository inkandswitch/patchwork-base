/**
 * `DocumentAreaRoot` — the threepane document column (draft scope + top bar +
 * main view + context sidebar), extracted so it can run either directly in the
 * host (`threepane`) or as an isolated `patchwork:component` inside the iframe
 * (`threepane-isolation`).
 *
 * It takes Accessor-shaped props uniformly: the local caller passes its reactive
 * accessors; the isolated caller (the mount fn in `isolation-entry.tsx`) wraps
 * parsed-JSON values in constant accessors, which is correct because any real
 * change to the boot spec reboots the iframe.
 *
 * The right-sidebar collapse/width state, its resize handlers, and the selected
 * context-tab signal live HERE (not threaded from the host), so they survive
 * inside the isolation boundary. The left sidebar is host-side; this component
 * only reads `isLeftCollapsed` for top-bar layout.
 */

import { type AutomergeUrl } from "@automerge/automerge-repo";
import { makePersisted } from "@solid-primitives/storage";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
} from "solid-js";
import type { ToolSlot } from "../types";
import {
  useProviderReady,
  useTaggedComponents,
  SIDEBAR_KEYS,
  COLLAPSE_CONTEXT_SIDEBAR_EVENT,
} from "../hooks";
import { useSidebarResize } from "../hooks/useSidebarResize";
import { FrameTopBar } from "./FrameTopBar";
import { ContextSidebar } from "./ContextSidebar";
import { MainDocumentView } from "./MainDocumentView";

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 720;
// Drag a sidebar narrower than this and it snaps closed (Things-3 style).
const AUTO_CLOSE_WIDTH = 120;
const DRAG_THRESHOLD = 3;

/**
 * The reactive inputs the document area needs, shared by both the local caller
 * (`PatchworkFrame` → `DocumentAreaRoot`) and the isolated caller
 * (`IsolatedDocumentArea`, which forwards them into the boot spec). The host
 * owns these — including reading the right-sidebar seeds from localStorage — so
 * both paths receive an identical contract.
 */
export interface DocumentAreaInputs {
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  /** The host-side left sidebar's collapsed state, for top-bar layout only. */
  isLeftCollapsed: Accessor<boolean>;
  /** Seed values for the document-area-local right-sidebar state. */
  initialRightWidth: Accessor<number>;
  initialRightCollapsed: Accessor<boolean>;
}

export interface DocumentAreaRootProps extends DocumentAreaInputs {
  /**
   * Host-realm ref set when the main document view mounts, used by the host to
   * flip its left-sidebar `widgetsReady` gate. Only supplied in the local
   * (non-isolated) path; inside the iframe it stays undefined (that realm can't
   * drive the host's signal), which is correct.
   */
  setMainDocElement?: (el: HTMLElement) => void;
}

export function DocumentAreaRoot(props: DocumentAreaRootProps) {
  // ── Right-sidebar state (document-area-local) ──────────────────
  // Lives here so it survives inside the isolation boundary. Seeded from props
  // (the host reads persisted values from its localStorage and passes them in,
  // since localStorage is stubbed inside the sandboxed iframe). Persisted back
  // to localStorage when host-side; a harmless no-op inside the iframe.
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = createSignal(
    props.initialRightCollapsed()
  );
  const [rightSidebarWidth, setRightSidebarWidth] = createSignal(
    props.initialRightWidth()
  );

  createEffect(
    on(
      isRightSidebarCollapsed,
      (value) => {
        try {
          localStorage.setItem(SIDEBAR_KEYS.rightCollapsed, String(value));
        } catch {
          /* localStorage stubbed inside the iframe */
        }
      },
      { defer: true }
    )
  );
  createEffect(
    on(
      rightSidebarWidth,
      (value) => {
        try {
          localStorage.setItem(SIDEBAR_KEYS.rightWidth, String(value));
        } catch {
          /* localStorage stubbed inside the iframe */
        }
      },
      { defer: true }
    )
  );

  // Right-sidebar-only resize. There is no left sidebar in this subtree, so the
  // "left" branch of the hook is never exercised — `handleMouseDown` /
  // `handleToggleClick` are only ever called with side="right" by the context
  // sidebar. The left signals below exist purely to satisfy the hook's typed
  // params; left-collapsed is read from the host prop.
  const [, setUnusedLeftWidth] = createSignal(0);
  const [, setUnusedLeftCollapsed] = createSignal(false);
  const sidebarResize = useSidebarResize({
    setLeftSidebarWidth: setUnusedLeftWidth,
    setRightSidebarWidth,
    setIsSidebarCollapsed: setUnusedLeftCollapsed,
    setIsRightSidebarCollapsed,
    isLeftCollapsed: () => props.isLeftCollapsed(),
    isRightCollapsed: isRightSidebarCollapsed,
    minWidth: MIN_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
    autoCloseWidth: AUTO_CLOSE_WIDTH,
    dragThreshold: DRAG_THRESHOLD,
  });

  // The host collapses the left sidebar directly, but the right-sidebar collapse
  // state lives here, so it asks us to collapse out-of-band via a window event
  // (e.g. after a finger-tap opens a document in the left sidebar — see
  // `FrameLayout`). Only wired on the host (non-isolated) path; the sandboxed
  // iframe realm never receives the host's window events.
  onMount(() => {
    const onCollapse = () => setIsRightSidebarCollapsed(true);
    window.addEventListener(COLLAPSE_CONTEXT_SIDEBAR_EVENT, onCollapse);
    onCleanup(() =>
      window.removeEventListener(COLLAPSE_CONTEXT_SIDEBAR_EVENT, onCollapse)
    );
  });

  // Selected context-sidebar tab, lifted above the per-draft remount boundary so
  // the active tab survives branch switches even though its content remounts.
  const [selectedContextToolId, setSelectedContextToolId] = makePersisted(
    createSignal<string | undefined>(),
    { name: SIDEBAR_KEYS.contextToolId }
  );

  // Per-document draft scope. Keyed on the selected doc URL so the whole draft
  // tree remounts when the user switches docs: the draft-list provider reads
  // its `doc-url` attribute once at mount (attribute changes are ignored while
  // a `component` attribute is set), so it cannot re-point in place.
  const [draftListProviderHost, setDraftListProviderHost] =
    createSignal<HTMLElement>();
  const isDraftListProviderReady = useProviderReady(
    "patchwork-draft-list-provider",
    draftListProviderHost
  );
  const readyDraftListHost = () =>
    isDraftListProviderReady() ? draftListProviderHost() : undefined;

  return (
    <Show when={props.selectedDocUrl()} keyed>
      {(docUrl) => (
        <patchwork-view
          component="patchwork-draft-list-provider"
          doc-url={docUrl}
          ref={setDraftListProviderHost}
        >
          <Show when={readyDraftListHost()}>
            {(host) => (
              <DraftDocumentArea
                host={host()}
                setMainDocElement={props.setMainDocElement}
                selectedDocUrl={props.selectedDocUrl}
                selectedToolId={props.selectedToolId}
                doctitleSlots={props.doctitleSlots}
                isLeftCollapsed={props.isLeftCollapsed}
                isRightSidebarCollapsed={isRightSidebarCollapsed}
                setIsRightSidebarCollapsed={setIsRightSidebarCollapsed}
                rightSidebarWidth={rightSidebarWidth}
                handleMouseDown={sidebarResize.handleMouseDown}
                handleToggleClick={sidebarResize.handleToggleClick}
                selectedContextToolId={selectedContextToolId}
                setSelectedContextToolId={setSelectedContextToolId}
              />
            )}
          </Show>
        </patchwork-view>
      )}
    </Show>
  );
}

// Renders the main document inside the draft-overlay provider. The provider
// mounts once and follows the checked-out draft itself (via the draft-list
// provider's `draft:checked-out` doc), re-pointing live document handles in
// place — so neither a draft switch nor a history checkpoint move remounts
// anything here. Checkpoint pins travel on the *backing* url inside the
// streamed `repo:handle-descriptor` answers (see `DraftOverlayProvider`), so
// the presented doc url the view is keyed on stays stable while scrubbing.
//
// The comments + focus providers and the context (right) sidebar live *inside*
// the overlay so that, on a draft, comment threads / selection resolve against
// the draft's clone. The document toolbar (top bar) is in that scope too — it
// targets the same selected doc as the editor.
function DraftDocumentArea(props: {
  host: HTMLElement;
  setMainDocElement?: (el: HTMLElement) => void;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  isLeftCollapsed: Accessor<boolean>;
  isRightSidebarCollapsed: Accessor<boolean>;
  setIsRightSidebarCollapsed: (
    value: boolean | ((prev: boolean) => boolean)
  ) => void;
  rightSidebarWidth: Accessor<number>;
  handleMouseDown: (side: "left" | "right", e: MouseEvent) => void;
  handleToggleClick: (side: "left" | "right", e: MouseEvent) => void;
  selectedContextToolId: Accessor<string | undefined>;
  setSelectedContextToolId: (id: string) => void;
}) {
  // Registry-driven: whether the context sidebar exists at all (any tabs) — no
  // longer depends on any per-account config, just on whether anything is
  // currently tagged `context-tool`. The system tray is separate host chrome in
  // the left sidebar (see `PatchworkFrame`) and no longer gates this column.
  const contextItems = useTaggedComponents("context-tool");
  const hasContext = () => contextItems().length > 0;

  // Remount key for the main view: just the selected doc. Checkpoint pins no
  // longer ride on this url — the overlay provider streams them on the
  // descriptors' *backing* urls and `OverlayRepo` swaps handle backings in
  // place, so scrubbing history must not (and does not) change this key.
  // Stamping heads here would also override the streamed pin: in
  // `OverlayRepo`, heads on the presented url win over the backing's.
  const mainViewKey = createMemo<string | undefined>(() =>
    props.selectedDocUrl()
  );

  const [draftOverlayProviderHost, setDraftOverlayProviderHost] =
    createSignal<HTMLElement>();
  const isDraftOverlayProviderReady = useProviderReady(
    "patchwork-draft-overlay-provider",
    draftOverlayProviderHost
  );

  const [commentsProviderElement, setCommentsProviderElement] =
    createSignal<HTMLElement>();
  const isCommentsProviderReady = useProviderReady(
    "patchwork-comments-provider",
    commentsProviderElement
  );

  const [focusProviderElement, setFocusProviderElement] =
    createSignal<HTMLElement>();
  const isFocusProviderReady = useProviderReady(
    "patchwork-focus-provider",
    focusProviderElement
  );

  const areDocProvidersReady = createMemo(
    () =>
      isDraftOverlayProviderReady() &&
      isCommentsProviderReady() &&
      isFocusProviderReady()
  );

  return (
    <patchwork-view
      component="patchwork-draft-overlay-provider"
      ref={setDraftOverlayProviderHost}
    >
      <patchwork-view
        component="patchwork-comments-provider"
        ref={setCommentsProviderElement}
      >
        <patchwork-view
          component="patchwork-focus-provider"
          ref={setFocusProviderElement}
        >
          <Show when={areDocProvidersReady()}>
            <div class="frame__main-column">
              <div class="frame__doc-column">
                <FrameTopBar
                  docUrl={props.selectedDocUrl}
                  toolSlots={props.doctitleSlots}
                  isLeftCollapsed={props.isLeftCollapsed}
                  hasContext={hasContext}
                  isRightCollapsed={props.isRightSidebarCollapsed}
                  onToggleRight={() =>
                    props.setIsRightSidebarCollapsed((v) => !v)
                  }
                />

                <div class="main-area">
                  <MainDocumentView
                    viewKey={mainViewKey}
                    selectedDocUrl={props.selectedDocUrl}
                    toolId={props.selectedToolId}
                    // Always pass a function ref. Passing `ref={undefined}`
                    // (the isolated path, where no host ref is threaded)
                    // makes Solid's component-ref codegen fall back to
                    // assigning the prop, which throws on the getter-only
                    // reactive props object. A no-op wrapper avoids that.
                    ref={(el) => props.setMainDocElement?.(el)}
                  />
                </div>
              </div>

              <Show when={hasContext()}>
                <ContextSidebar
                  selectedToolId={props.selectedContextToolId}
                  setSelectedToolId={props.setSelectedContextToolId}
                  isCollapsed={props.isRightSidebarCollapsed}
                  width={props.rightSidebarWidth}
                  onMouseDown={props.handleMouseDown}
                  onToggleClick={props.handleToggleClick}
                  onCollapse={() => props.setIsRightSidebarCollapsed(true)}
                />
              </Show>
            </div>
          </Show>
        </patchwork-view>
      </patchwork-view>
    </patchwork-view>
  );
}
