import { useDocHandle } from "@automerge/automerge-repo-solid-primitives";
import type { DocHandle, Repo } from "@automerge/automerge-repo";
import type { AccountDoc } from "./types";
import {
  useSidebarState,
  useSidebarResize,
  useProviderReady,
  useDebugRegistryToast,
  DebugRegistryToast,
} from "./hooks";
import { Sidebar } from "./components/Sidebar";
import { DocumentToolbar } from "./components/DocumentToolbar";
import { MainDocumentView } from "./components/MainDocumentView";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { ensureAccountSubdocs } from "./account/ensureSubdocs";
import "./styles.css";
import { useSelectedView } from "./hooks/useSelectedDocument";

// Sidebar dimensions
const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

const VERSION = "v1.0.8-comments";

export const PatchworkFrame = ({
  handle,
  element,
  repo,
}: {
  handle: DocHandle<AccountDoc>;
  element: HTMLElement | ShadowRoot;
  repo: Repo;
}) => {
  // Track doc changes via a version counter so accountDoc() recomputes
  // on every change. We avoid useDocument/autoproduce because its store
  // proxying conflicts with Automerge array splice operations.
  const accountDocHandle = useDocHandle<AccountDoc>(() => handle.url, { repo });

  // Lazily populate subdoc fields (rootFolderUrl, moduleSettingsUrl, contactUrl)
  // on first mount. Each is created via createDocOfDatatype2 of its own
  // datatype, so defaults and shape are owned by the datatype, not the frame.
  void ensureAccountSubdocs(handle, repo);

  const [docVersion, setDocVersion] = createSignal(0);

  createEffect(() => {
    const h = accountDocHandle();
    if (!h) return;
    const onChange = () => setDocVersion((v) => v + 1);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });

  const accountDoc = createMemo(() => {
    docVersion();
    return accountDocHandle()?.doc();
  });

  const accountDocUrl = handle.url;

  // Sidebar state management
  const sidebarState = useSidebarState();

  // Sidebar resize handlers
  const { handleMouseDown, handleToggleClick } = useSidebarResize({
    setLeftSidebarWidth: sidebarState.setLeftSidebarWidth,
    setRightSidebarWidth: sidebarState.setRightSidebarWidth,
    setIsSidebarCollapsed: sidebarState.setIsSidebarCollapsed,
    setIsRightSidebarCollapsed: sidebarState.setIsRightSidebarCollapsed,
    minWidth: MIN_SIDEBAR_WIDTH,
    dragThreshold: DRAG_THRESHOLD,
  });

  // Selected document management
  const selectedView = useSelectedView({
    element,
    repo,
  });

  // Debug registry toast
  const {
    events: debugEvents,
    dismissEvent,
    clearAll,
  } = useDebugRegistryToast();

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

  const [accountProviderElement, setAccountProviderElement] =
    createSignal<HTMLElement>();
  const isAccountProviderReady = useProviderReady(
    "patchwork-account-provider",
    accountProviderElement
  );

  const [selectedDocProviderElement, setSelectedDocProviderElement] =
    createSignal<HTMLElement>();
  const isSelectedDocProviderReady = useProviderReady(
    "patchwork-selected-doc-provider",
    selectedDocProviderElement
  );

  return (
    <div class="frame">
      <div class="frame__version" title="Patchwork frame version">
        Frame {VERSION}
      </div>

      <DebugRegistryToast
        events={debugEvents()}
        onDismiss={dismissEvent}
        onClearAll={clearAll}
      />

      {/*
        Outermost provider: wraps both sidebars and the main area so that
        `patchwork:open-document` events from anywhere (and the matching
        `patchwork:selected-doc` subscriptions) reach it. `patchwork-view`
        defaults to `display: contents`, so this wrapper is layout-neutral.
      */}
      <patchwork-view
        component="patchwork-selected-doc-provider"
        ref={setSelectedDocProviderElement}
      >
        <Show when={isSelectedDocProviderReady()}>
          {/* Left Sidebar */}
          {accountDoc()?.accountSidebarToolId && (
            <Sidebar
              side="left"
              isCollapsed={sidebarState.isSidebarCollapsed}
              width={sidebarState.leftSidebarWidth}
              toolId={accountDoc()!.accountSidebarToolId}
              docUrl={accountDocUrl}
              onMouseDown={handleMouseDown}
              onToggleClick={handleToggleClick}
            />
          )}

          <patchwork-view
            component="patchwork-comments-provider"
            ref={setCommentsProviderElement}
          >
            <Show when={isCommentsProviderReady()}>
              <patchwork-view
                component="patchwork-focus-provider"
                ref={setFocusProviderElement}
              >
                <Show when={isFocusProviderReady()}>
                  <patchwork-view
                    component="patchwork-account-provider"
                    doc-url={accountDocUrl}
                    ref={setAccountProviderElement}
                  >
                    <Show when={isAccountProviderReady()}>
                      {/* Main Content Area */}
                      <div class="main-area">
                        <DocumentToolbar
                          toolIds={() => accountDoc()?.documentToolbarToolIds}
                          docUrl={() => selectedView()?.url}
                        />
                        <MainDocumentView
                          viewKey={() => selectedView()?.url}
                          selectedDocUrl={() => selectedView()?.url}
                          toolId={() => selectedView()?.toolId}
                        />
                      </div>

                      {/* Right Sidebar */}
                      {accountDoc()?.contextSidebarToolId && (
                        <Sidebar
                          side="right"
                          isCollapsed={sidebarState.isRightSidebarCollapsed}
                          width={sidebarState.rightSidebarWidth}
                          toolId={accountDoc()!.contextSidebarToolId}
                          docUrl={accountDocUrl}
                          onMouseDown={handleMouseDown}
                          onToggleClick={handleToggleClick}
                        />
                      )}
                    </Show>
                  </patchwork-view>
                </Show>
              </patchwork-view>
            </Show>
          </patchwork-view>
        </Show>
      </patchwork-view>
    </div>
  );
};
