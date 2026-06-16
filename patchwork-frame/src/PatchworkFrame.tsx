import "@inkandswitch/patchwork-elements";
import { useDocHandle } from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
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
  type Accessor,
  type JSX,
} from "solid-js";
import { ensureAccountSubdocs } from "./account/ensureSubdocs";
import "./styles.css";

type DraftsState = {
  drafts: AutomergeUrl[];
  // `null` represents "main" — i.e. the host doc itself, no draft overlay.
  selectedDraft: AutomergeUrl | null;
};

type SelectedView = {
  url: AutomergeUrl;
  toolId: string | null;
};

type SidebarResize = ReturnType<typeof useSidebarResize>;
type SidebarState = ReturnType<typeof useSidebarState>;

const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

export const PatchworkFrame = ({
  handle,
  repo,
}: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
}) => {
  const accountDocUrl = handle.url;

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
    () => isSelectedDocProviderReady() && isAccountProviderReady()
  );

  return (
    <div class="frame">
      {/*
        Outermost providers: wrap both sidebars and the main area so that
        `patchwork:open-document` events from anywhere (and the matching
        `patchwork:selected-doc` subscriptions) reach them. The comments and
        focus providers are deliberately *not* here - they live inside the
        per-draft overlay (see `DraftDocumentArea`) so branch comments resolve
        against the draft's clone. `patchwork-view` defaults to
        `display: contents`, so these wrappers are layout-neutral.
      */}
      <patchwork-view
        component="patchwork-selected-doc-provider"
        ref={setSelectedDocProviderElement}
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

  const selectedDocUrl = () => selectedView()?.url;
  const selectedToolId = () => selectedView()?.toolId ?? undefined;

  // Per-document draft scope. Keyed on the selected doc URL so the whole
  // draft tree remounts when the user switches docs. When no doc is selected
  // we still render the sidebars (so the drafts sidebar can show its
  // "no doc selected" empty state), just without a draft-root scope.
  const [draftListProviderHost, setDraftListProviderHost] =
    createSignal<HTMLElement>();
  const isDraftListProviderReady = useProviderReady(
    "patchwork-draft-list-provider",
    draftListProviderHost
  );
  const readyDraftListHost = () =>
    isDraftListProviderReady() ? draftListProviderHost() : undefined;

  return (
    <div ref={element} style={{ display: "contents" }}>
      <DebugRegistryToast
        events={debugEvents()}
        onDismiss={dismissEvent}
        onClearAll={clearAll}
      />

      <Show
        when={selectedDocUrl()}
        keyed
        fallback={
          <FrameLayout
            accountDoc={accountDoc}
            accountDocUrl={accountDocUrl}
            sidebarState={sidebarState}
            sidebarResize={sidebarResize}
          >
            <div class="main-area">
              <MainDocumentView
                viewKey={selectedDocUrl}
                selectedDocUrl={selectedDocUrl}
                toolId={selectedToolId}
              />
            </div>
          </FrameLayout>
        }
      >
        {(docUrl) => (
          <patchwork-view
            component="patchwork-draft-list-provider"
            doc-url={docUrl}
            ref={setDraftListProviderHost}
          >
            <Show when={readyDraftListHost()}>
              {(host) => (
                <FrameLayout
                  accountDoc={accountDoc}
                  accountDocUrl={accountDocUrl}
                  sidebarState={sidebarState}
                  sidebarResize={sidebarResize}
                >
                  <DraftDocumentArea
                    host={host()}
                    accountDoc={accountDoc}
                    accountDocUrl={accountDocUrl}
                    selectedDocUrl={selectedDocUrl}
                    selectedToolId={selectedToolId}
                    sidebarState={sidebarState}
                    sidebarResize={sidebarResize}
                  />
                </FrameLayout>
              )}
            </Show>
          </patchwork-view>
        )}
      </Show>
    </div>
  );
}

// Left (account) sidebar plus a slot for the main column. Shared by the no-doc
// fallback and the in-draft layout. The right (context) sidebar is *not* here:
// it lives inside the per-draft overlay (see `DraftDocumentArea`) so the
// comments-view tab resolves the draft's clone. Consequently it only renders
// when a document is selected.
function FrameLayout(props: {
  accountDoc: Accessor<AccountDoc | undefined>;
  accountDocUrl: AutomergeUrl;
  sidebarState: SidebarState;
  sidebarResize: SidebarResize;
  children: JSX.Element;
}) {
  return (
    <>
      {props.accountDoc()?.accountSidebarToolId && (
        <Sidebar
          side="left"
          isCollapsed={props.sidebarState.isSidebarCollapsed}
          width={props.sidebarState.leftSidebarWidth}
          toolId={props.accountDoc()!.accountSidebarToolId}
          docUrl={props.accountDocUrl}
          onMouseDown={props.sidebarResize.handleMouseDown}
          onToggleClick={props.sidebarResize.handleToggleClick}
        />
      )}

      {props.children}
    </>
  );
}

// Reads the draft list state from the draft-list provider, then renders the
// main document inside a draft-overlay provider keyed on the selected draft.
// The overlay provider is always mounted; it becomes a no-op when its `url`
// is empty (the "main" case), letting document resolution fall through to the
// host repo.
//
// The comments + focus providers and the context (right) sidebar live *inside*
// the overlay so that, on a draft, comment threads / selection resolve against
// the draft's clone. They wrap both the editor and the sidebar (which must be a
// flex sibling of `.main-area`), so the overlay is mounted at the `.frame`
// level here; `patchwork-view` is `display: contents`, keeping the
// [left | main-area | right] layout intact. The document toolbar is included in
// that scope too - it targets the same selected doc as the editor (no extra
// cloning), and `OverlayHandle.url` still reports the original url so
// identity-sensitive toolbar tools (e.g. add-to-sidebar) are unaffected.
function DraftDocumentArea(props: {
  host: HTMLElement;
  accountDoc: Accessor<AccountDoc | undefined>;
  accountDocUrl: AutomergeUrl;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  sidebarState: SidebarState;
  sidebarResize: SidebarResize;
}) {
  const [draftsState] = subscribeDoc<DraftsState>(props.host, {
    type: "patchwork:drafts",
  });

  const draftProviderKey = createMemo<AutomergeUrl | "main">(
    () => draftsState()?.selectedDraft ?? "main"
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
    <Show when={draftProviderKey()} keyed>
      {(key) => (
        <patchwork-view
          component="patchwork-draft-overlay-provider"
          url={key === "main" ? "" : key}
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
                <div class="main-area">
                  <DocumentToolbar
                    toolIds={() => props.accountDoc()?.documentToolbarToolIds}
                    docUrl={props.selectedDocUrl}
                  />
                  <MainDocumentView
                    viewKey={props.selectedDocUrl}
                    selectedDocUrl={props.selectedDocUrl}
                    toolId={props.selectedToolId}
                  />
                </div>

                {props.accountDoc()?.contextSidebarToolId && (
                  <Sidebar
                    side="right"
                    isCollapsed={props.sidebarState.isRightSidebarCollapsed}
                    width={props.sidebarState.rightSidebarWidth}
                    toolId={props.accountDoc()!.contextSidebarToolId}
                    docUrl={props.accountDocUrl}
                    onMouseDown={props.sidebarResize.handleMouseDown}
                    onToggleClick={props.sidebarResize.handleToggleClick}
                  />
                )}
              </Show>
            </patchwork-view>
          </patchwork-view>
        </patchwork-view>
      )}
    </Show>
  );
}
