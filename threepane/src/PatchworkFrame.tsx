import "@inkandswitch/patchwork-elements";
import {
  useDocHandle,
  useDocument,
} from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import type { AccountDoc, ThreepaneConfigDoc, ToolRef } from "./types";
import {
  useSidebarState,
  useSidebarResize,
  useProviderReady,
  useDebugRegistryToast,
  DebugRegistryToast,
} from "./hooks";
import { Sidebar } from "./components/Sidebar";
import { ContextSidebar } from "./components/ContextSidebar";
import { FrameTopBar } from "./components/FrameTopBar";
import { SidebarWidgets } from "./components/SidebarWidgets";
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
import { ensureThreepaneConfig } from "./account/ensureThreepaneConfig";
// Imported as a string (not a side-effect import) so the stylesheet is only
// injected when the frame tool actually activates — not when index.js loads.
import frameStyles from "./styles.css?inline";

function ensureFrameStyles() {
  const id = "patchwork-frame-styles";
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = frameStyles;
  document.head.append(el);
}

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

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 720;
// Drag a sidebar narrower than this and it snaps closed (Things-3 style).
const AUTO_CLOSE_WIDTH = 120;
const DRAG_THRESHOLD = 3;

export const PatchworkFrame = ({
  handle,
  repo,
}: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
}) => {
  ensureFrameStyles();
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
  // on first mount, then create the threepane layout config doc and migrate the
  // legacy account arrays into it (non-destructive — old fields stay so older
  // builds keep working). Ordered: the migration seeds the sidebar's default
  // document-list widget against rootFolderUrl, so the subdocs must land first.
  void (async () => {
    await ensureAccountSubdocs(props.handle, props.repo);
    await ensureThreepaneConfig(props.handle, props.repo);
  })();

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

  // The threepane layout config doc (sidebar widgets / context tabs / doctitle
  // tools). Read via handle + version counter (same reason as accountDoc: store
  // proxying conflicts with Automerge splice).
  const threepaneUrl = () => accountDoc()?.tools?.["threepane"];
  const threepaneConfigHandle = useDocHandle<ThreepaneConfigDoc>(
    () => threepaneUrl(),
    { repo: props.repo }
  );
  const [threepaneVersion, setThreepaneVersion] = createSignal(0);
  createEffect(() => {
    const h = threepaneConfigHandle();
    if (!h) return;
    const onChange = () => setThreepaneVersion((v) => v + 1);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });
  const threepaneConfig = createMemo(() => {
    threepaneVersion();
    return threepaneConfigHandle()?.doc();
  });

  // Derived layout lanes, read from the threepane config doc. The migration
  // seeds it from the legacy account fields (dropping the intrinsic title +
  // spacer); older builds read those fields directly, so branch-flipping stays
  // safe without a fallback here.
  const doctitleToolIds = () =>
    threepaneConfig()?.doctitle?.tools?.map((ref) => ref[0]);
  const contextTabIds = () =>
    threepaneConfig()?.contextbar?.tabs?.map((ref) => ref[0]);
  const sidebarWidgets = (): ToolRef[] =>
    threepaneConfig()?.sidebar?.widgets ?? [];
  const rootFolderUrl = () => accountDoc()?.rootFolderUrl;

  const sidebarState = useSidebarState();
  const sidebarResize = useSidebarResize({
    setLeftSidebarWidth: sidebarState.setLeftSidebarWidth,
    setRightSidebarWidth: sidebarState.setRightSidebarWidth,
    setIsSidebarCollapsed: sidebarState.setIsSidebarCollapsed,
    setIsRightSidebarCollapsed: sidebarState.setIsRightSidebarCollapsed,
    isLeftCollapsed: sidebarState.isSidebarCollapsed,
    isRightCollapsed: sidebarState.isRightSidebarCollapsed,
    minWidth: MIN_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
    autoCloseWidth: AUTO_CLOSE_WIDTH,
    dragThreshold: DRAG_THRESHOLD,
  });

  // Selected context-sidebar tab, lifted here (above the per-document and
  // per-draft remount boundaries) so the active tab survives document and
  // branch switches even though the tab's tool content remounts.
  const [selectedContextToolId, setSelectedContextToolId] =
    createSignal<string>();

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

  // Per-document draft scope. The provider element persists across navigation:
  // we feed it a reactive `doc-url` and it re-points in place (it watches the
  // attribute), rather than remounting the whole draft subtree on every doc
  // switch. When no doc is selected we still render the sidebars (so the drafts
  // sidebar can show its "no doc selected" empty state), just without a
  // draft-root scope.
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
        fallback={
          <FrameLayout
            accountDoc={accountDoc}
            accountDocUrl={accountDocUrl}
            sidebarState={sidebarState}
            sidebarResize={sidebarResize}
            sidebarWidgets={sidebarWidgets}
            configHandle={threepaneConfigHandle}
            rootFolderUrl={rootFolderUrl}
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
        {/*
          Not keyed: the provider element stays mounted across navigation and
          re-points itself when `doc-url` changes, so we don't tear down and
          rebuild the whole draft subtree (and its ephemeral DraftsState doc)
          on every doc switch.
        */}
        <patchwork-view
          component="patchwork-draft-list-provider"
          doc-url={selectedDocUrl()}
          ref={setDraftListProviderHost}
        >
          <Show when={readyDraftListHost()}>
            {(host) => (
              <FrameLayout
                accountDoc={accountDoc}
                accountDocUrl={accountDocUrl}
                sidebarState={sidebarState}
                sidebarResize={sidebarResize}
                sidebarWidgets={sidebarWidgets}
                configHandle={threepaneConfigHandle}
                rootFolderUrl={rootFolderUrl}
              >
                <DraftDocumentArea
                  host={host()}
                  repo={props.repo}
                  accountDoc={accountDoc}
                  accountDocUrl={accountDocUrl}
                  selectedDocUrl={selectedDocUrl}
                  selectedToolId={selectedToolId}
                  doctitleToolIds={doctitleToolIds}
                  contextTabIds={contextTabIds}
                  sidebarState={sidebarState}
                  sidebarResize={sidebarResize}
                  selectedContextToolId={selectedContextToolId}
                  setSelectedContextToolId={setSelectedContextToolId}
                />
              </FrameLayout>
            )}
          </Show>
        </patchwork-view>
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
  sidebarWidgets: Accessor<ToolRef[]>;
  configHandle: Accessor<DocHandle<ThreepaneConfigDoc> | undefined>;
  rootFolderUrl: Accessor<AutomergeUrl | undefined>;
  children: JSX.Element;
}) {
  const isCollapsed = props.sidebarState.isSidebarCollapsed;
  return (
    <>
      {/*
        The left toggle is pinned to the frame's top-left corner (absolute,
        outside the collapsing sidebar) so it holds the same spot whether the
        sidebar is open or closed. The title, in the top bar, slides up against
        it as the sidebar closes rather than travelling the full sidebar width.
      */}
      <button
        type="button"
        class="frame__sidebar-toggle frame__left-toggle"
        title={isCollapsed() ? "Show sidebar" : "Hide sidebar"}
        aria-label={isCollapsed() ? "Show sidebar" : "Hide sidebar"}
        aria-pressed={!isCollapsed()}
        onClick={() =>
          props.sidebarState.setIsSidebarCollapsed((v) => !v)
        }
      >
        <PanelLeftIcon />
      </button>

      <Sidebar
        side="left"
        isCollapsed={isCollapsed}
        width={props.sidebarState.leftSidebarWidth}
        onMouseDown={props.sidebarResize.handleMouseDown}
        onToggleClick={props.sidebarResize.handleToggleClick}
      >
        <div class="threepane-sidebar">
          <SidebarWidgets
            widgets={props.sidebarWidgets}
            configHandle={props.configHandle}
            rootFolderUrl={props.rootFolderUrl}
          />
          {/* account / packages / settings, pinned to the sidebar's bottom */}
          <div class="threepane-sidebar__footer">
            <patchwork-view
              doc-url={props.accountDocUrl}
              tool-id="chee/account-bar"
            />
          </div>
        </div>
      </Sidebar>

      {props.children}
    </>
  );
}

// lucide `panel-left`
function PanelLeftIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
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
  repo: Repo;
  accountDoc: Accessor<AccountDoc | undefined>;
  accountDocUrl: AutomergeUrl;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleToolIds: Accessor<string[] | undefined>;
  contextTabIds: Accessor<string[] | undefined>;
  sidebarState: SidebarState;
  sidebarResize: SidebarResize;
  selectedContextToolId: Accessor<string | undefined>;
  setSelectedContextToolId: (id: string) => void;
}) {
  const [draftsState] = subscribeDoc<DraftsState>(props.host, {
    type: "draft:list",
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
                <div class="frame__main-column">
                  <FrameTopBar
                    repo={props.repo}
                    docUrl={props.selectedDocUrl}
                    toolIds={props.doctitleToolIds}
                    isLeftCollapsed={props.sidebarState.isSidebarCollapsed}
                    contextToolIds={props.contextTabIds}
                    selectedContextToolId={props.selectedContextToolId}
                    setSelectedContextToolId={props.setSelectedContextToolId}
                    isRightCollapsed={props.sidebarState.isRightSidebarCollapsed}
                    rightWidth={props.sidebarState.rightSidebarWidth}
                    onToggleRight={() =>
                      props.sidebarState.setIsRightSidebarCollapsed((v) => !v)
                    }
                  />

                  <div class="frame__content-row">
                    <div class="main-area">
                      <MainDocumentView
                        viewKey={props.selectedDocUrl}
                        selectedDocUrl={props.selectedDocUrl}
                        toolId={props.selectedToolId}
                      />
                    </div>

                    <Show when={!!props.contextTabIds()?.length}>
                      <ContextSidebar
                        contextToolIds={props.contextTabIds}
                        docUrl={props.accountDocUrl}
                        selectedToolId={props.selectedContextToolId}
                        isCollapsed={props.sidebarState.isRightSidebarCollapsed}
                        width={props.sidebarState.rightSidebarWidth}
                        onMouseDown={props.sidebarResize.handleMouseDown}
                        onToggleClick={props.sidebarResize.handleToggleClick}
                      />
                    </Show>
                  </div>
                </div>
              </Show>
            </patchwork-view>
          </patchwork-view>
        </patchwork-view>
      )}
    </Show>
  );
}
