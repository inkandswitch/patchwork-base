import {
  useDocHandle,
  createDocSignal,
} from "@automerge/automerge-repo-solid-primitives";
import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import type { DocWithComments } from "@inkandswitch/annotations-comments";
import { request } from "@inkandswitch/patchwork-providers";
import type { AccountDoc } from "./types";
import {
  useSidebarState,
  useSidebarResize,
  useSelectedDocument,
  useAnnotations,
  useCommentThreads,
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

type DraftsState = {
  drafts: AutomergeUrl[];
  // `null` represents "main" — i.e. the host doc itself, no draft overlay.
  selectedDraft: AutomergeUrl | null;
};

const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

const VERSION = "v1.3.0-flat-drafts";

export const PatchworkFrame = ({
  handle,
  element,
  repo,
}: {
  handle: DocHandle<AccountDoc>;
  element: HTMLElement | ShadowRoot;
  repo: Repo;
}) => {
  const accountDocHandle = useDocHandle<AccountDoc>(() => handle.url, { repo });

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

  const sidebarState = useSidebarState();
  const { handleMouseDown, handleToggleClick } = useSidebarResize({
    setLeftSidebarWidth: sidebarState.setLeftSidebarWidth,
    setRightSidebarWidth: sidebarState.setRightSidebarWidth,
    setIsSidebarCollapsed: sidebarState.setIsSidebarCollapsed,
    setIsRightSidebarCollapsed: sidebarState.setIsRightSidebarCollapsed,
    minWidth: MIN_SIDEBAR_WIDTH,
    dragThreshold: DRAG_THRESHOLD,
  });

  const selectedDoc = useSelectedDocument({ element, repo });

  const commentThreadsWithRef = useCommentThreads(
    () =>
      selectedDoc.selectedDocHandle() as DocHandle<DocWithComments> | undefined,
    repo
  );

  useAnnotations({
    selectedDocRef: selectedDoc.selectedDocRef,
    commentThreadsWithRef,
  });

  const {
    events: debugEvents,
    dismissEvent,
    clearAll,
  } = useDebugRegistryToast();

  const [commentsProviderHost, setCommentsProviderHost] =
    createSignal<HTMLElement>();
  const isCommentsProviderReady = useProviderReady(
    "patchwork-comments-provider",
    commentsProviderHost
  );

  const [focusProviderHost, setFocusProviderHost] = createSignal<HTMLElement>();
  const isFocusProviderReady = useProviderReady(
    "patchwork-focus-provider",
    focusProviderHost
  );

  const [draftListProviderHost, setDraftListProviderHost] =
    createSignal<HTMLElement>();
  const isDraftListProviderReady = useProviderReady(
    "patchwork-draft-list-provider",
    draftListProviderHost
  );

  const [draftsStateHandle, setDraftsStateHandle] = createSignal<
    DocHandle<DraftsState> | undefined
  >();

  createEffect(() => {
    if (!isDraftListProviderReady()) return;
    const host = draftListProviderHost();
    if (!host) return;
    let cancelled = false;
    request<DocHandle<DraftsState> | null>(host, "patchwork:drafts").then(
      (h) => {
        if (cancelled || !h) return;
        setDraftsStateHandle(() => h);
      }
    );
    onCleanup(() => {
      cancelled = true;
      setDraftsStateHandle(undefined);
    });
  });

  const draftsState = createDocSignal<DraftsState>(draftsStateHandle);

  const draftProviderKey = createMemo<AutomergeUrl | "main">(
    () => draftsState()?.selectedDraft ?? "main"
  );

  const [draftOverlayProviderHost, setDraftOverlayProviderHost] =
    createSignal<HTMLElement>();
  const isDraftOverlayProviderReady = useProviderReady(
    "patchwork-draft-overlay-provider",
    draftOverlayProviderHost
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

      <patchwork-view
        component="patchwork-comments-provider"
        ref={setCommentsProviderHost}
      >
        <Show when={isCommentsProviderReady()}>
          <patchwork-view
            component="patchwork-focus-provider"
            ref={setFocusProviderHost}
          >
            <Show when={isFocusProviderReady()}>
              {/* Per-document draft scope. Keyed on the selected doc URL
               * so the whole draft tree remounts when the user switches
               * docs. When no doc is selected we still render sidebars
               * (so the drafts sidebar can show its "no doc selected"
               * empty state, etc.), just without a draft-root scope. */}
              <Show
                when={selectedDoc.selectedDocUrl()}
                keyed
                fallback={
                  <>
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
                    <div class="main-area">
                      <MainDocumentView
                        viewKey={selectedDoc.viewKey}
                        selectedDocUrl={selectedDoc.selectedDocUrl}
                        toolId={() => selectedDoc.selectedView()?.toolId}
                      />
                    </div>
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
                  </>
                }
              >
                {(docUrl) => (
                  <patchwork-view
                    component="patchwork-draft-list-provider"
                    doc-url={docUrl}
                    ref={setDraftListProviderHost}
                  >
                    <Show when={isDraftListProviderReady()}>
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

                      <div class="main-area">
                        <DocumentToolbar
                          toolIds={() => accountDoc()?.documentToolbarToolIds}
                          docUrl={selectedDoc.selectedDocUrl}
                        />
                        {/* Draft overlay provider is always mounted; it
                         * becomes a no-op when its `url` attribute is
                         * empty (the "main" case), letting requests
                         * bubble up to the host repo. Keying on
                         * `draftProviderKey` remounts on selection
                         * change. */}
                        <Show when={draftProviderKey()} keyed>
                          {(key) => (
                            <patchwork-view
                              component="patchwork-draft-overlay-provider"
                              url={key === "main" ? "" : key}
                              ref={setDraftOverlayProviderHost}
                            >
                              <Show when={isDraftOverlayProviderReady()}>
                                <MainDocumentView
                                  viewKey={selectedDoc.viewKey}
                                  selectedDocUrl={selectedDoc.selectedDocUrl}
                                  toolId={() =>
                                    selectedDoc.selectedView()?.toolId
                                  }
                                />
                              </Show>
                            </patchwork-view>
                          )}
                        </Show>
                      </div>

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
                )}
              </Show>
            </Show>
          </patchwork-view>
        </Show>
      </patchwork-view>
    </div>
  );
};
