import "@inkandswitch/patchwork-elements";
import { useDocHandle } from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
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
  onMount,
  Show,
} from "solid-js";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { ensureAccountSubdocs } from "./account/ensureSubdocs";
import "./styles.css";

// Sidebar dimensions
const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

type SelectedView = {
  url: AutomergeUrl;
  toolId: string | null;
};

export const PatchworkFrame = ({
  handle,
  repo,
}: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
}) => {
  const accountDocUrl = handle.url;

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

  const areProvidersReady = createMemo(
    () =>
      isSelectedDocProviderReady() &&
      isCommentsProviderReady() &&
      isFocusProviderReady() &&
      isAccountProviderReady()
  );

  return (
    <div class="frame">
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
        <patchwork-view
          component="patchwork-comments-provider"
          ref={setCommentsProviderElement}
        >
          <patchwork-view
            component="patchwork-focus-provider"
            ref={setFocusProviderElement}
          >
            <patchwork-view
              component="patchwork-account-provider"
              doc-url={accountDocUrl}
              ref={setAccountProviderElement}
            >
              <Show when={areProvidersReady()}>
                <PatchworkFrameInner handle={handle} repo={repo} />
              </Show>
            </patchwork-view>
          </patchwork-view>
        </patchwork-view>
      </patchwork-view>
    </div>
  );
};

function PatchworkFrameInner(props: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
}) {
  // Track doc changes via a version counter so accountDoc() recomputes
  // on every change. We avoid useDocument/autoproduce because its store
  // proxying conflicts with Automerge array splice operations.
  const accountDocHandle = useDocHandle<AccountDoc>(() => props.handle.url, {
    repo: props.repo,
  });

  // Lazily populate subdoc fields (rootFolderUrl, moduleSettingsUrl, contactUrl)
  // on first mount. Each is created via createDocOfDatatype2 of its own
  // datatype, so defaults and shape are owned by the datatype, not the frame.
  void ensureAccountSubdocs(props.handle, props.repo);

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
  const accountDocUrl = props.handle.url;

  const sidebarState = useSidebarState();
  const sidebarResize = useSidebarResize({
    setLeftSidebarWidth: sidebarState.setLeftSidebarWidth,
    setRightSidebarWidth: sidebarState.setRightSidebarWidth,
    setIsSidebarCollapsed: sidebarState.setIsSidebarCollapsed,
    setIsRightSidebarCollapsed: sidebarState.setIsRightSidebarCollapsed,
    minWidth: MIN_SIDEBAR_WIDTH,
    dragThreshold: DRAG_THRESHOLD,
  });

  const {
    events: debugEvents,
    dismissEvent,
    clearAll,
  } = useDebugRegistryToast();

  let element!: HTMLDivElement;
  const [selectedView, setSelectedView] = createSignal<SelectedView | null>(
    null
  );

  onMount(() => {
    const unsubscribeSelectedView = subscribe<SelectedView | null>(
      element,
      { type: "patchwork:selected-view" },
      (view) => setSelectedView(view)
    );

    onCleanup(unsubscribeSelectedView);
  });

  return (
    <div ref={element} style={{ display: "contents" }}>
      <DebugRegistryToast
        events={debugEvents()}
        onDismiss={dismissEvent}
        onClearAll={clearAll}
      />

      {accountDoc()?.accountSidebarToolId && (
        <Sidebar
          side="left"
          isCollapsed={sidebarState.isSidebarCollapsed}
          width={sidebarState.leftSidebarWidth}
          toolId={accountDoc()!.accountSidebarToolId}
          docUrl={accountDocUrl}
          onMouseDown={sidebarResize.handleMouseDown}
          onToggleClick={sidebarResize.handleToggleClick}
        />
      )}

      <div class="main-area">
        <DocumentToolbar
          toolIds={() => accountDoc()?.documentToolbarToolIds}
          docUrl={() => selectedView()?.url}
        />
        <MainDocumentView
          viewKey={() => selectedView()?.url}
          selectedDocUrl={() => selectedView()?.url}
          toolId={() => selectedView()?.toolId ?? undefined}
        />
      </div>

      {accountDoc()?.contextSidebarToolId && (
        <Sidebar
          side="right"
          isCollapsed={sidebarState.isRightSidebarCollapsed}
          width={sidebarState.rightSidebarWidth}
          toolId={accountDoc()!.contextSidebarToolId}
          docUrl={accountDocUrl}
          onMouseDown={sidebarResize.handleMouseDown}
          onToggleClick={sidebarResize.handleToggleClick}
        />
      )}
    </div>
  );
}
