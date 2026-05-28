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
  useDebugRegistryToast,
  DebugRegistryToast,
} from "./hooks";
import { Sidebar } from "./components/Sidebar";
import { DocumentToolbar } from "./components/DocumentToolbar";
import { MainDocumentView } from "./components/MainDocumentView";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { ensureAccountSubdocs } from "./account/ensureSubdocs";
import "./styles.css";

type WorkspaceState = {
  drafts: AutomergeUrl[];
  selectedDraft: AutomergeUrl;
};

const MIN_SIDEBAR_WIDTH = 48;
const DRAG_THRESHOLD = 3;

const VERSION = "v1.1.0-comments";

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

  // Gate consumers on `patchwork:mounted` so their `patchwork:request`
  // events don't fly before the listener attaches.
  const [isCommentsProviderReady, setCommentsProviderReady] =
    createSignal(false);
  const [isFocusProviderReady, setFocusProviderReady] = createSignal(false);

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

  const [isWorkspaceProviderReady, setWorkspaceProviderReady] =
    createSignal(false);
  const [workspaceProviderHost, setWorkspaceProviderHost] =
    createSignal<HTMLElement | undefined>();
  const attachWorkspaceProviderReadyListener = (host: HTMLElement) => {
    setWorkspaceProviderReady(false);
    setWorkspaceProviderHost(host);
    const onMounted = (event: Event) => {
      const detail = (event as CustomEvent<{ componentId?: string }>).detail;
      if (detail?.componentId !== "patchwork-workspace-provider") return;
      setWorkspaceProviderReady(true);
    };
    host.addEventListener("patchwork:mounted", onMounted);
    onCleanup(() => host.removeEventListener("patchwork:mounted", onMounted));
  };

  // `selectedDraft` feeds a keyed <Show> below so the draft provider (+
  // everything draft-scoped) remounts on switch.
  const [workspaceStateHandle, setWorkspaceStateHandle] =
    createSignal<DocHandle<WorkspaceState> | undefined>();
  const [stateTick, setStateTick] = createSignal(0);

  createEffect(() => {
    if (!isWorkspaceProviderReady()) return;
    const host = workspaceProviderHost();
    if (!host) return;
    let cancelled = false;
    request<DocHandle<WorkspaceState>>(host, "patchwork:drafts").then(
      (h) => {
        if (cancelled || !h) return;
        setWorkspaceStateHandle(() => h);
      }
    );
    onCleanup(() => {
      cancelled = true;
      setWorkspaceStateHandle(undefined);
    });
  });

  createEffect(() => {
    const h = workspaceStateHandle();
    if (!h) return;
    const onChange = () => setStateTick((t) => t + 1);
    h.on("change", onChange);
    onCleanup(() => h.off("change", onChange));
  });

  const selectedDraft = createMemo<AutomergeUrl | undefined>(() => {
    stateTick();
    return workspaceStateHandle()?.doc()?.selectedDraft;
  });

  const [isDraftProviderReady, setDraftProviderReady] = createSignal(false);
  const attachDraftProviderReadyListener = (host: HTMLElement) => {
    setDraftProviderReady(false);
    const onMounted = (event: Event) => {
      const detail = (event as CustomEvent<{ componentId?: string }>).detail;
      if (detail?.componentId !== "patchwork-draft-provider") return;
      setDraftProviderReady(true);
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

      <patchwork-view
        component="patchwork-comments-provider"
        ref={makeProviderReadyListener(
          "patchwork-comments-provider",
          setCommentsProviderReady
        )}
      >
        <Show when={isCommentsProviderReady()}>
          <patchwork-view
            component="patchwork-focus-provider"
            ref={makeProviderReadyListener(
              "patchwork-focus-provider",
              setFocusProviderReady
            )}
          >
            <Show
              when={isFocusProviderReady() && accountDoc()?.rootFolderUrl}
              keyed
            >
              {(rootFolderUrl) => (
                <patchwork-view
                  component="patchwork-workspace-provider"
                  url={rootFolderUrl}
                  ref={attachWorkspaceProviderReadyListener}
                >
                  <Show when={isWorkspaceProviderReady()}>
                    {/* Keyed remount on draft switch rebinds useRepo()/useDocument(). */}
                    <Show when={selectedDraft()} keyed>
                      {(draftUrl) => (
                        <patchwork-view
                          component="patchwork-draft-provider"
                          url={draftUrl}
                          ref={attachDraftProviderReadyListener}
                        >
                          <Show when={isDraftProviderReady()}>
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
                                toolIds={() =>
                                  accountDoc()?.documentToolbarToolIds
                                }
                                docUrl={selectedDoc.selectedDocUrl}
                              />
                              <MainDocumentView
                                viewKey={selectedDoc.viewKey}
                                selectedDocUrl={selectedDoc.selectedDocUrl}
                                toolId={() => selectedDoc.selectedView()?.toolId}
                              />
                            </div>
                          </Show>
                        </patchwork-view>
                      )}
                    </Show>

                    {/* Outside the draft scope: survives draft switches and
                      * resolves `patchwork:repo` to the root repo. */}
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
          </patchwork-view>
        </Show>
      </patchwork-view>
    </div>
  );
};
