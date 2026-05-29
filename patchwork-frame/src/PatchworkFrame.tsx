import { useDocHandle } from "@automerge/automerge-repo-solid-primitives";
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
  selectedDraft: AutomergeUrl;
};

const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

const VERSION = "v1.2.0-per-doc-drafts";

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

  const [draftRootProviderHost, setDraftRootProviderHost] =
    createSignal<HTMLElement>();
  const isDraftRootProviderReady = useProviderReady(
    "patchwork-draft-root-provider",
    draftRootProviderHost
  );

  const [draftsStateHandle, setDraftsStateHandle] = createSignal<
    DocHandle<DraftsState> | undefined
  >();
  const [stateTick, setStateTick] = createSignal(0);

  createEffect(() => {
    if (!isDraftRootProviderReady()) return;
    const host = draftRootProviderHost();
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

  createEffect(() => {
    const h = draftsStateHandle();
    if (!h) return;
    const onChange = () => setStateTick((t) => t + 1);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });

  const selectedDraft = createMemo<AutomergeUrl | undefined>(() => {
    stateTick();
    return draftsStateHandle()?.doc()?.selectedDraft;
  });

  const [draftProviderHost, setDraftProviderHost] = createSignal<HTMLElement>();
  const isDraftProviderReady = useProviderReady(
    "patchwork-draft-provider",
    draftProviderHost
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
                    component="patchwork-draft-root-provider"
                    doc-url={docUrl}
                    ref={setDraftRootProviderHost}
                  >
                    <Show when={isDraftRootProviderReady()}>
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
                        {/* Inner draft provider only mounts when a draft
                         * is selected — i.e. the host doc has
                         * `@patchwork.draftUrl` set. Otherwise we render
                         * the main view directly against the root repo. */}
                        <Show
                          when={selectedDraft()}
                          keyed
                          fallback={
                            <MainDocumentView
                              viewKey={selectedDoc.viewKey}
                              selectedDocUrl={selectedDoc.selectedDocUrl}
                              toolId={() => selectedDoc.selectedView()?.toolId}
                            />
                          }
                        >
                          {(draftUrl) => (
                            <patchwork-view
                              component="patchwork-draft-provider"
                              url={draftUrl}
                              ref={setDraftProviderHost}
                            >
                              <Show when={isDraftProviderReady()}>
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
