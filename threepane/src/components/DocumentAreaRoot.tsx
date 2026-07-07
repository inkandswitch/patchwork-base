/**
 * `DocumentAreaRoot` — the threepane document column (draft scope + top bar +
 * main view), extracted so it can run either directly in the
 * host (`threepane`) or as an isolated `patchwork:component` inside the iframe
 * (`threepane-isolation`).
 *
 * It takes Accessor-shaped props uniformly: the local caller passes its reactive
 * accessors; the isolated caller (the mount fn in `isolation-entry.tsx`) wraps
 * parsed-JSON values in constant accessors, which is correct because any real
 * change to the boot spec reboots the iframe.
 *
 * The context sidebar and system tray stay host-side in `PatchworkFrame`, so
 * they have one stable instance and remain outside the isolation boundary.
 * This component only reads the host sidebar state for top-bar layout.
 */

import type { AutomergeUrl } from "@automerge/automerge-repo";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import type { ToolSlot } from "../types";
import { useProviderReady } from "../hooks";
import { FrameTopBar } from "./FrameTopBar";
import { MainDocumentView } from "./MainDocumentView";

type DraftsState = {
  drafts: AutomergeUrl[];
  // `null` represents "main" — i.e. the host doc itself, no draft overlay.
  selectedDraft: AutomergeUrl | null;
};

/**
 * The reactive inputs the document area needs, shared by both the local caller
 * (`PatchworkFrame` → `DocumentAreaRoot`) and the isolated caller
 * (`IsolatedDocumentArea`, which forwards them into the boot spec).
 */
export interface DocumentAreaInputs {
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  /** The host-side left sidebar's collapsed state, for top-bar layout only. */
  isLeftCollapsed: Accessor<boolean>;
  hasContext?: Accessor<boolean>;
  isRightSidebarCollapsed?: Accessor<boolean>;
  onToggleRight?: () => void;
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
  return (
    <Show when={props.selectedDocUrl()} fallback={<NoDocumentColumn {...props} />}>
      <DraftScopedDocumentColumn
        setMainDocElement={props.setMainDocElement}
        selectedDocUrl={props.selectedDocUrl}
        selectedToolId={props.selectedToolId}
        doctitleSlots={props.doctitleSlots}
        isLeftCollapsed={props.isLeftCollapsed}
        hasContext={props.hasContext ?? (() => false)}
        isRightSidebarCollapsed={props.isRightSidebarCollapsed ?? (() => true)}
        onToggleRight={props.onToggleRight ?? (() => {})}
      />
    </Show>
  );
}

function NoDocumentColumn(props: DocumentAreaRootProps) {
  return (
    <div class="frame__doc-column">
      <FrameTopBar
        docUrl={props.selectedDocUrl}
        toolSlots={props.doctitleSlots}
        isLeftCollapsed={props.isLeftCollapsed}
        hasContext={() => false}
        isRightCollapsed={() => true}
        onToggleRight={() => {}}
      />

      <div class="main-area">
        <MainDocumentView
          viewKey={props.selectedDocUrl}
          selectedDocUrl={props.selectedDocUrl}
          toolId={props.selectedToolId}
          ref={(el) => props.setMainDocElement?.(el)}
        />
      </div>
    </div>
  );
}

function DraftScopedDocumentColumn(props: {
  setMainDocElement?: (el: HTMLElement) => void;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  isLeftCollapsed: Accessor<boolean>;
  hasContext: Accessor<boolean>;
  isRightSidebarCollapsed: Accessor<boolean>;
  onToggleRight: () => void;
}) {
  // Per-document draft scope. The provider element persists across navigation
  // while a document is selected: we feed it a reactive `doc-url` and it
  // re-points in place (it watches the attribute), rather than remounting the
  // whole draft subtree on every doc switch.
  const [draftListProviderHost, setDraftListProviderHost] =
    createSignal<HTMLElement>();
  const isDraftListProviderReady = useProviderReady(
    "patchwork-draft-list-provider",
    draftListProviderHost
  );
  const readyDraftListHost = () =>
    isDraftListProviderReady() ? draftListProviderHost() : undefined;

  return (
    <patchwork-view
      component="patchwork-draft-list-provider"
      doc-url={props.selectedDocUrl()}
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
            hasContext={props.hasContext}
            isRightSidebarCollapsed={props.isRightSidebarCollapsed}
            onToggleRight={props.onToggleRight}
          />
        )}
      </Show>
    </patchwork-view>
  );
}

// Reads the draft list state from the draft-list provider, then renders the
// main document inside a draft-overlay provider keyed on the selected draft.
// The overlay provider is always mounted; it becomes a no-op when its `url`
// is empty (the "main" case), letting document resolution fall through to the
// host repo.
//
// The comments + focus providers and document toolbar live *inside* the overlay
// so that, on a draft, comment threads / selection resolve against the draft's
// clone. The right context sidebar lives outside this provider branch so its
// tray components keep one stable instance across doc selection changes.
function DraftDocumentArea(props: {
  host: HTMLElement;
  setMainDocElement?: (el: HTMLElement) => void;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  isLeftCollapsed: Accessor<boolean>;
  hasContext: Accessor<boolean>;
  isRightSidebarCollapsed: Accessor<boolean>;
  onToggleRight: () => void;
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
                <div class="frame__doc-column">
                  <FrameTopBar
                    docUrl={props.selectedDocUrl}
                    toolSlots={props.doctitleSlots}
                    isLeftCollapsed={props.isLeftCollapsed}
                    hasContext={props.hasContext}
                    isRightCollapsed={props.isRightSidebarCollapsed}
                    onToggleRight={props.onToggleRight}
                  />

                  <div class="main-area">
                    <MainDocumentView
                      viewKey={props.selectedDocUrl}
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
              </Show>
            </patchwork-view>
          </patchwork-view>
        </patchwork-view>
      )}
    </Show>
  );
}
