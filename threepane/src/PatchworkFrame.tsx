import "@inkandswitch/patchwork-elements";
import {
  useDocHandle,
  useDocument,
} from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { subscribe } from "@inkandswitch/patchwork-providers";
import type {
  OpenDocumentEvent,
  OpenDocumentEventDetail,
} from "@inkandswitch/patchwork-elements";
import type { AccountDoc, ThreepaneConfigDoc, ToolSlot } from "./types";
import {
  useSidebarState,
  useSidebarResize,
  useProviderReady,
  useMainDocMounted,
  useDebugRegistryToast,
  DebugRegistryToast,
  getStoredNumber,
  getStoredBoolean,
  SIDEBAR_KEYS,
  DEFAULT_SIDEBAR_WIDTH,
} from "./hooks";
import { Sidebar } from "./components/Sidebar";
import { SidebarWidgets } from "./components/SidebarWidgets";
import { MainDocumentView } from "./components/MainDocumentView";
import { slotId } from "./components/SlotView";
import { DocumentAreaRoot } from "./components/DocumentAreaRoot";
import { IsolatedDocumentArea } from "./components/IsolatedDocumentArea";
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
import { ensureFrameStyles } from "./ensureFrameStyles";

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

// Fire a `patchwork:open-document` request from an account-bar button. Bubbles +
// composed so it reaches the footer intercept (isolation → popover) or the
// selected-doc provider (otherwise → main frame), matching the sideboard tool.
function dispatchOpen(el: HTMLElement, detail: OpenDocumentEventDetail) {
  el.dispatchEvent(
    new CustomEvent("patchwork:open-document", {
      detail,
      bubbles: true,
      composed: true,
    })
  );
}

export const PatchworkFrame = ({
  handle,
  repo,
  ...props
}: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
  isolation?: boolean;
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
        per-draft overlay (inside `DocumentAreaRoot`) so branch comments resolve
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
            <PatchworkFrameInner
              handle={handle}
              repo={repo}
              isolation={props.isolation}
            />
          </Show>
        </patchwork-view>
      </patchwork-view>
    </div>
  );
};

function PatchworkFrameInner(props: {
  handle: DocHandle<AccountDoc>;
  repo: Repo;
  isolation?: boolean;
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
  // doctitle / tray / contextbar lanes keep their full slots (a [toolId, docId]
  // tuple or a bare component-id string); SlotView decides how to render each.
  // The context tab bar + selection work in ids, so contextbar also exposes a
  // flattened id list.
  const doctitleSlots = () => threepaneConfig()?.doctitle?.tools;
  const traySlots = () => threepaneConfig()?.tray?.tools;
  const contextTabSlots = () => threepaneConfig()?.contextbar?.tabs;
  const contextTabIds = () => threepaneConfig()?.contextbar?.tabs?.map(slotId);
  const sidebarWidgets = (): ToolSlot[] =>
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

  const {
    events: debugEvents,
    dismissEvent,
    clearAll,
  } = useDebugRegistryToast();

  let element!: HTMLDivElement;
  const [selectedView, setSelectedView] = createSignal<SelectedView | null>(
    null
  );

  // Under isolation the main document area lives inside a sandboxed iframe, so
  // host-realm chrome tools opened from the account bar (account picker /
  // Packages / Settings) must NOT be routed into it as a `selected-view` — they
  // need host repo access the iframe is denied. FrameLayout intercepts their
  // `patchwork:open-document` events (stopping them before they reach the
  // selected-doc provider) and surfaces them here, floating in a popover over
  // the frame instead. Off-isolation this stays null and the events open in the
  // main frame as usual.
  const [popoverView, setPopoverView] = createSignal<SelectedView | null>(null);

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

  // Right-sidebar seeds, read from host localStorage. The host owns this read and
  // hands the values to whichever document-area path renders (local DocumentAreaRoot
  // or the isolated root via IsolatedDocumentArea's boot spec) — localStorage is
  // stubbed inside the iframe, so the isolated path can't read it itself.
  const initialRightWidth = () =>
    getStoredNumber(SIDEBAR_KEYS.rightWidth, DEFAULT_SIDEBAR_WIDTH);
  const initialRightCollapsed = () =>
    getStoredBoolean(SIDEBAR_KEYS.rightCollapsed);

  // Suspend the sidebar widgets until the main document has settled (mounted or
  // failed to mount), so the primary column wins the initial render race. With
  // no document selected there's nothing to wait for, so the widgets show
  // immediately. Latched: once revealed they stay mounted across later doc
  // switches — we only want to win the *first* race, not re-suspend every time.
  //
  // Under isolation the main document lives inside the iframe, so the host-side
  // mount ref can never be set; we reveal the widgets immediately instead of
  // gating on a mount that will never reach this realm.
  const [mainDocElement, setMainDocElement] = createSignal<HTMLElement>();
  const isMainDocMounted = useMainDocMounted(mainDocElement, selectedDocUrl);
  const [widgetsReady, setWidgetsReady] = createSignal(false);
  createEffect(() => {
    if (widgetsReady()) return;
    if (props.isolation || !selectedDocUrl() || isMainDocMounted())
      setWidgetsReady(true);
  });

  return (
    <div ref={element} style={{ display: "contents" }}>
      <DebugRegistryToast
        events={debugEvents()}
        onDismiss={dismissEvent}
        onClearAll={clearAll}
      />

      {/*
        FrameLayout (the left sidebar + its toggle) is rendered ONCE, outside
        the doc-selection Show. Selecting the first document only swaps the main
        column below; it must not tear down and rebuild the entire left sidebar
        (widgets, account bar) — that's a full-world remount on first click.
      */}
      <FrameLayout
        accountDocUrl={accountDocUrl}
        sidebarState={sidebarState}
        sidebarResize={sidebarResize}
        sidebarWidgets={sidebarWidgets}
        configHandle={threepaneConfigHandle}
        rootFolderUrl={rootFolderUrl}
        widgetsReady={widgetsReady}
        contactUrl={() => accountDoc()?.contactUrl}
        moduleSettingsUrl={() => accountDoc()?.moduleSettingsUrl}
        isolation={props.isolation}
        onInterceptOpen={setPopoverView}
      >
        <Show
          when={selectedDocUrl()}
          fallback={
            <div class="main-area">
              <MainDocumentView
                viewKey={selectedDocUrl}
                selectedDocUrl={selectedDocUrl}
                toolId={selectedToolId}
                ref={setMainDocElement}
              />
            </div>
          }
        >
          {/*
            Document area: isolated (rendered inside a sandboxed iframe) or local
            (rendered directly). `isolation` is fixed per tool instance. The local
            path threads `setMainDocElement` (for the host's widgetsReady race) and
            seeds the right-sidebar state from host localStorage; the isolated path
            owns that wiring itself (and can't drive the host ref from the iframe).
          */}
          <Show
            when={props.isolation}
            fallback={
              <DocumentAreaRoot
                setMainDocElement={setMainDocElement}
                selectedDocUrl={selectedDocUrl}
                selectedToolId={selectedToolId}
                doctitleSlots={doctitleSlots}
                traySlots={traySlots}
                contextTabIds={contextTabIds}
                contextTabSlots={contextTabSlots}
                isLeftCollapsed={sidebarState.isSidebarCollapsed}
                initialRightWidth={initialRightWidth}
                initialRightCollapsed={initialRightCollapsed}
              />
            }
          >
            <IsolatedDocumentArea
              contactUrl={accountDoc()?.contactUrl}
              selectedDocUrl={selectedDocUrl}
              selectedToolId={selectedToolId}
              doctitleSlots={doctitleSlots}
              traySlots={traySlots}
              contextTabIds={contextTabIds}
              contextTabSlots={contextTabSlots}
              isLeftCollapsed={sidebarState.isSidebarCollapsed}
              initialRightWidth={initialRightWidth}
              initialRightCollapsed={initialRightCollapsed}
            />
          </Show>
        </Show>
      </FrameLayout>

      <Show when={popoverView()}>
        {(view) => (
          <FramePopover view={view()} onClose={() => setPopoverView(null)} />
        )}
      </Show>
    </div>
  );
}

// The isolation-mode chrome popover: floats a host-realm tool (account picker /
// Packages / Settings) over the frame on a dimmed, theme-tinted wash so it can
// run in the host realm instead of being routed into the isolated main frame.
// Click the backdrop or press Escape to dismiss.
function FramePopover(props: { view: SelectedView; onClose: () => void }) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="frame__popover-backdrop" onClick={() => props.onClose()}>
      <div
        class="frame__popover"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <patchwork-view
          doc-url={props.view.url}
          tool-id={props.view.toolId ?? undefined}
        />
      </div>
    </div>
  );
}

// Host-side frame chrome: the left (account) sidebar plus a slot for the main
// column (`children`). Rendered once and kept mounted across the no-doc → doc
// transition; only its `children` (the main column) swap. The right (context)
// sidebar is *not* here — it lives inside the document area (`DocumentAreaRoot`).
function FrameLayout(props: {
  accountDocUrl: AutomergeUrl;
  sidebarState: SidebarState;
  sidebarResize: SidebarResize;
  sidebarWidgets: Accessor<ToolSlot[]>;
  configHandle: Accessor<DocHandle<ThreepaneConfigDoc> | undefined>;
  rootFolderUrl: Accessor<AutomergeUrl | undefined>;
  widgetsReady: Accessor<boolean>;
  /** Account subdocs for the inlined account bar (avatar + Packages buttons). */
  contactUrl: Accessor<AutomergeUrl | undefined>;
  moduleSettingsUrl: Accessor<AutomergeUrl | undefined>;
  /** Fixed per tool instance: whether the main document area is isolated. */
  isolation?: boolean;
  /** Isolation only: called with an account-bar tool to open in the popover. */
  onInterceptOpen?: (view: SelectedView) => void;
  children: JSX.Element;
}) {
  const isCollapsed = props.sidebarState.isSidebarCollapsed;

  // Under isolation, intercept `patchwork:open-document` events fired by the
  // account bar (account picker / Packages / Settings) at the footer, before
  // they bubble to the selected-doc provider. Left to propagate they'd select a
  // view for the isolated main frame — the sandboxed iframe — where these
  // host-realm chrome tools can't run. We stop them here and hand them to the
  // host-side popover instead. Off-isolation the events pass straight through.
  let footerEl: HTMLDivElement | undefined;
  onMount(() => {
    if (!props.isolation || !footerEl) return;
    const el = footerEl;
    const onOpen = (event: OpenDocumentEvent) => {
      const { url, toolId } = event.detail;
      if (!url) return;
      event.stopPropagation();
      props.onInterceptOpen?.({ url, toolId: toolId ?? null });
    };
    el.addEventListener("patchwork:open-document", onOpen);
    onCleanup(() => el.removeEventListener("patchwork:open-document", onOpen));
  });
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
        onClick={() => props.sidebarState.setIsSidebarCollapsed((v) => !v)}
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
            ready={props.widgetsReady}
          />
          {/*
            The account bar — avatar (account picker) + Packages + Settings —
            pinned to the sidebar's bottom. Inlined here directly rather than
            mounted as the `chee/account-bar` sideboard tool, so the frame owns
            the markup. Each button dispatches a `patchwork:open-document` event
            (bubbles + composed), which the footer intercepts into the popover
            under isolation, or lets bubble to the selected-doc provider
            otherwise — exactly the flow the sideboard tool had.
          */}
          <div class="threepane-sidebar__footer" ref={footerEl}>
            <footer class="threepane-account-bar">
              <Show when={props.contactUrl()}>
                {(contactUrl) => (
                  <button
                    type="button"
                    class="threepane-account-bar__button threepane-account-bar__avatar"
                    title="Account"
                    aria-label="Account"
                    onClick={(e) =>
                      dispatchOpen(e.currentTarget, {
                        url: props.accountDocUrl,
                        toolId: "account-picker",
                      })
                    }
                  >
                    <patchwork-view
                      doc-url={contactUrl()}
                      tool-id="contact-avatar"
                    />
                  </button>
                )}
              </Show>

              <Show when={props.moduleSettingsUrl()}>
                {(moduleSettingsUrl) => (
                  <button
                    type="button"
                    class="threepane-account-bar__button"
                    onClick={(e) =>
                      dispatchOpen(e.currentTarget, { url: moduleSettingsUrl() })
                    }
                  >
                    Packages
                  </button>
                )}
              </Show>

              <button
                type="button"
                class="threepane-account-bar__button"
                onClick={(e) =>
                  dispatchOpen(e.currentTarget, {
                    url: props.accountDocUrl,
                    toolId: "frame-configurator",
                  })
                }
              >
                Settings
              </button>
            </footer>
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
