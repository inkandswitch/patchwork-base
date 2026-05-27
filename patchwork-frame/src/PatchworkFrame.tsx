import { useDocHandle } from "@automerge/automerge-repo-solid-primitives";
import type { DocHandle, Repo } from "@automerge/automerge-repo";
import type { DocWithComments } from "@inkandswitch/annotations-comments";
import type { AccountDoc } from "./types";
import {
  useSidebarState,
  useSidebarResize,
  useSelectedDocument,
  useAnnotations,
  useCommentThreads,
  useDebugRegistryToast,
  DebugRegistryToast,
} from "./hooks";
import { Sidebar } from "./components/Sidebar";
import { DocumentToolbar } from "./components/DocumentToolbar";
import { MainDocumentView } from "./components/MainDocumentView";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { ensureAccountSubdocs } from "./account/ensureSubdocs";
import "./styles.css";

// Sidebar dimensions
const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

const VERSION = "v1.0.7-comments";

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
  const selectedDoc = useSelectedDocument({
    element,
    repo,
  });

  // Comment threads for selected document
  const commentThreadsWithRef = useCommentThreads(
    () =>
      selectedDoc.selectedDocHandle() as DocHandle<DocWithComments> | undefined,
    repo
  );

  // Annotations management
  useAnnotations({
    selectedDocRef: selectedDoc.selectedDocRef,
    commentThreadsWithRef,
  });

  // Debug registry toast
  const {
    events: debugEvents,
    dismissEvent,
    clearAll,
  } = useDebugRegistryToast();

  // Wait for each provider to mount before rendering consumers, so their
  // patchwork:request events aren't dispatched before the provider has
  // attached its listener.
  const [isCommentsProviderReady, setCommentsProviderReady] =
    createSignal(false);
  const [isFocusProviderReady, setFocusProviderReady] =
    createSignal(false);

  const makeProviderReadyListener =
    (componentId: string, setReady: (value: boolean) => void) =>
    (host: HTMLElement) => {
      const onMounted = (event: Event) => {
        const detail = (event as CustomEvent<{ componentId?: string }>).detail;
        if (detail?.componentId !== componentId) return;
        setReady(true);
      };
      host.addEventListener("patchwork:mounted", onMounted);
      onCleanup(() => host.removeEventListener("patchwork:mounted", onMounted));
    };

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

      <patchwork-component
        component="patchwork-comments-provider"
        ref={makeProviderReadyListener(
          "patchwork-comments-provider",
          setCommentsProviderReady
        )}
      >
        <Show when={isCommentsProviderReady()}>
          <patchwork-component
            component="patchwork-focus-provider"
            ref={makeProviderReadyListener(
              "patchwork-focus-provider",
              setFocusProviderReady
            )}
          >
            <Show when={isFocusProviderReady()}>
              {/* Main Content Area */}
              <div class="main-area">
                <DocumentToolbar
                  toolIds={() => accountDoc()?.documentToolbarToolIds}
                  docUrl={selectedDoc.selectedDocUrl}
                />
                <MainDocumentView
                  viewKey={selectedDoc.viewKey}
                  selectedDocUrl={selectedDoc.selectedDocUrl}
                  toolId={() => selectedDoc.selectedView()?.toolId}
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
          </patchwork-component>
        </Show>
      </patchwork-component>
    </div>
  );
};
