/**
 * `DocumentAreaRoot` — the threepane document column (draft scope + top bar +
 * main view + context sidebar), extracted so it can run either directly in the
 * host (`threepane`) or as an isolated `patchwork:component` inside the iframe
 * (`threepane-isolation`).
 *
 * It takes Accessor-shaped props uniformly: the local caller passes its reactive
 * accessors; the isolated caller (the mount fn in `isolation-entry.tsx`) wraps
 * parsed-JSON values in constant accessors, which is correct because any real
 * change to the boot spec reboots the iframe.
 *
 * The right-sidebar collapse/width state, its resize handlers, and the selected
 * context-tab signal live HERE (not threaded from the host), so they survive
 * inside the isolation boundary. The left sidebar is host-side; this component
 * only reads `isLeftCollapsed` for top-bar layout.
 */

import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type UrlHeads,
} from "@automerge/automerge-repo";
import { subscribeDoc } from "@inkandswitch/patchwork-providers-solid";
import { makePersisted } from "@solid-primitives/storage";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  Show,
  type Accessor,
} from "solid-js";
import type { ToolSlot } from "../types";
import { useProviderReady, useTaggedComponents, SIDEBAR_KEYS } from "../hooks";
import { useSidebarResize } from "../hooks/useSidebarResize";
import { FrameTopBar } from "./FrameTopBar";
import { ContextSidebar } from "./ContextSidebar";
import { MainDocumentView } from "./MainDocumentView";

// Mirrors the drafts package's `CheckedOutDraft`/`DraftCheckpoint`: the small
// writeable doc that holds the current selection plus an optional history pin.
// Each member doc's original url maps to the heads to view it at (`to`, which the
// frame reads to pin the doc) and to diff against (`from`, read by the drafts
// provider to serve `draft:baseline`). A doc absent from the map stays live.
type DocCheckpoint = {
  from?: UrlHeads;
  to?: UrlHeads;
};

type DraftCheckpoint = Record<AutomergeUrl, DocCheckpoint>;

type CheckedOutDraft = {
  // `null` represents "main" — i.e. the host doc itself, no draft overlay.
  checkedOut: AutomergeUrl | null;
  // Absent/null = live latest heads; set = a frozen, read-only history view.
  at?: DraftCheckpoint | null;
};

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 720;
// Drag a sidebar narrower than this and it snaps closed (Things-3 style).
const AUTO_CLOSE_WIDTH = 120;
const DRAG_THRESHOLD = 3;

/**
 * The reactive inputs the document area needs, shared by both the local caller
 * (`PatchworkFrame` → `DocumentAreaRoot`) and the isolated caller
 * (`IsolatedDocumentArea`, which forwards them into the boot spec). The host
 * owns these — including reading the right-sidebar seeds from localStorage — so
 * both paths receive an identical contract.
 */
export interface DocumentAreaInputs {
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  /** The host-side left sidebar's collapsed state, for top-bar layout only. */
  isLeftCollapsed: Accessor<boolean>;
  /** Seed values for the document-area-local right-sidebar state. */
  initialRightWidth: Accessor<number>;
  initialRightCollapsed: Accessor<boolean>;
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
  // ── Right-sidebar state (document-area-local) ──────────────────
  // Lives here so it survives inside the isolation boundary. Seeded from props
  // (the host reads persisted values from its localStorage and passes them in,
  // since localStorage is stubbed inside the sandboxed iframe). Persisted back
  // to localStorage when host-side; a harmless no-op inside the iframe.
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = createSignal(
    props.initialRightCollapsed()
  );
  const [rightSidebarWidth, setRightSidebarWidth] = createSignal(
    props.initialRightWidth()
  );

  createEffect(
    on(
      isRightSidebarCollapsed,
      (value) => {
        try {
          localStorage.setItem(SIDEBAR_KEYS.rightCollapsed, String(value));
        } catch {
          /* localStorage stubbed inside the iframe */
        }
      },
      { defer: true }
    )
  );
  createEffect(
    on(
      rightSidebarWidth,
      (value) => {
        try {
          localStorage.setItem(SIDEBAR_KEYS.rightWidth, String(value));
        } catch {
          /* localStorage stubbed inside the iframe */
        }
      },
      { defer: true }
    )
  );

  // Right-sidebar-only resize. There is no left sidebar in this subtree, so the
  // "left" branch of the hook is never exercised — `handleMouseDown` /
  // `handleToggleClick` are only ever called with side="right" by the context
  // sidebar. The left signals below exist purely to satisfy the hook's typed
  // params; left-collapsed is read from the host prop.
  const [, setUnusedLeftWidth] = createSignal(0);
  const [, setUnusedLeftCollapsed] = createSignal(false);
  const sidebarResize = useSidebarResize({
    setLeftSidebarWidth: setUnusedLeftWidth,
    setRightSidebarWidth,
    setIsSidebarCollapsed: setUnusedLeftCollapsed,
    setIsRightSidebarCollapsed,
    isLeftCollapsed: () => props.isLeftCollapsed(),
    isRightCollapsed: isRightSidebarCollapsed,
    minWidth: MIN_SIDEBAR_WIDTH,
    maxWidth: MAX_SIDEBAR_WIDTH,
    autoCloseWidth: AUTO_CLOSE_WIDTH,
    dragThreshold: DRAG_THRESHOLD,
  });

  // Selected context-sidebar tab. Persisted so it survives reloads; the
  // sidebar itself stays mounted across draft switches (the overlay provider
  // re-points handles in place rather than remounting its subtree).
  const [selectedContextToolId, setSelectedContextToolId] = makePersisted(
    createSignal<string | undefined>(),
    { name: SIDEBAR_KEYS.contextToolId }
  );

  // Per-document draft scope. Keyed on the selected doc URL so the whole draft
  // tree remounts when the user switches docs: the draft-list provider reads
  // its `doc-url` attribute once at mount (attribute changes are ignored while
  // a `component` attribute is set), so it cannot re-point in place.
  const [draftListProviderHost, setDraftListProviderHost] =
    createSignal<HTMLElement>();
  const isDraftListProviderReady = useProviderReady(
    "patchwork-draft-list-provider",
    draftListProviderHost
  );
  const readyDraftListHost = () =>
    isDraftListProviderReady() ? draftListProviderHost() : undefined;

  return (
    <Show when={props.selectedDocUrl()} keyed>
      {(docUrl) => (
        <patchwork-view
          component="patchwork-draft-list-provider"
          doc-url={docUrl}
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
                isRightSidebarCollapsed={isRightSidebarCollapsed}
                setIsRightSidebarCollapsed={setIsRightSidebarCollapsed}
                rightSidebarWidth={rightSidebarWidth}
                handleMouseDown={sidebarResize.handleMouseDown}
                handleToggleClick={sidebarResize.handleToggleClick}
                selectedContextToolId={selectedContextToolId}
                setSelectedContextToolId={setSelectedContextToolId}
              />
            )}
          </Show>
        </patchwork-view>
      )}
    </Show>
  );
}

// Renders the main document inside the draft-overlay provider. The provider
// mounts pinned to one draft (its `url` attribute) and answers document
// descriptors one-shot, so switching drafts works by remounting the provider
// subtree on the checked-out draft (see `draftProviderKey`). Checking a
// history entry in or out likewise remounts the main view (see `mainViewKey`),
// since nested docs resolve their checkpoint pin once, at mount.
//
// The comments + focus providers and the context (right) sidebar live *inside*
// the overlay so that, on a draft, comment threads / selection resolve against
// the draft's clone. The document toolbar (top bar) is in that scope too — it
// targets the same selected doc as the editor.
function DraftDocumentArea(props: {
  host: HTMLElement;
  setMainDocElement?: (el: HTMLElement) => void;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  selectedToolId: Accessor<string | undefined>;
  doctitleSlots: Accessor<ToolSlot[] | undefined>;
  isLeftCollapsed: Accessor<boolean>;
  isRightSidebarCollapsed: Accessor<boolean>;
  setIsRightSidebarCollapsed: (
    value: boolean | ((prev: boolean) => boolean)
  ) => void;
  rightSidebarWidth: Accessor<number>;
  handleMouseDown: (side: "left" | "right", e: MouseEvent) => void;
  handleToggleClick: (side: "left" | "right", e: MouseEvent) => void;
  selectedContextToolId: Accessor<string | undefined>;
  setSelectedContextToolId: (id: string) => void;
}) {
  const [checkedOut] = subscribeDoc<CheckedOutDraft>(props.host, {
    type: "draft:checked-out",
  });

  // The overlay provider resolves descriptors one-shot against the draft in
  // its `url` attribute, so the whole provider subtree is keyed on the
  // selection: switching drafts remounts it and every descriptor is
  // re-requested against the new draft.
  const draftProviderKey = createMemo<AutomergeUrl | "main">(
    () => checkedOut()?.checkedOut ?? "main"
  );

  // Registry-driven: whether the right sidebar exists at all (tabs or tray)
  // no longer depends on any per-account config — just on whether anything is
  // currently tagged for either lane.
  const contextItems = useTaggedComponents("context-tool");
  const trayItems = useTaggedComponents("system-tray");
  const hasContextOrTray = () =>
    contextItems().length > 0 || trayItems().length > 0;

  // When a history entry is checked out, view the selected doc at its pinned
  // heads. The overlay reapplies these heads onto the draft's clone, yielding a
  // fixed-heads (read-only) handle. No pin -> the live, canonical url. Keying
  // the view on this url remounts the tool when entering/leaving a checkpoint.
  const pinnedDocUrl = createMemo<AutomergeUrl | undefined>(() => {
    const url = props.selectedDocUrl();
    if (!url) return url;
    const { documentId } = parseAutomergeUrl(url);
    const heads = checkedOut()?.at?.[stringifyAutomergeUrl({ documentId })]?.to;
    return heads ? stringifyAutomergeUrl({ documentId, heads }) : url;
  });

  // Remount key for the main view. Nested docs (embeds, folder entries) resolve
  // their checkpoint pin once, at mount, via `repo:handle-descriptor`; they only
  // re-resolve when the subtree remounts. `pinnedDocUrl` alone misses checkpoint
  // moves that don't change the main doc's own heads (e.g. an entry that only
  // pins an embedded doc), so fold the whole `at` map into the key.
  const mainViewKey = createMemo<string | undefined>(() => {
    const url = pinnedDocUrl();
    if (!url) return url;
    return `${url}|${JSON.stringify(checkedOut()?.at ?? null)}`;
  });

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
                  <div class="frame__doc-column">
                    <FrameTopBar
                      docUrl={props.selectedDocUrl}
                      toolSlots={props.doctitleSlots}
                      isLeftCollapsed={props.isLeftCollapsed}
                      hasContext={hasContextOrTray}
                      isRightCollapsed={props.isRightSidebarCollapsed}
                      onToggleRight={() =>
                        props.setIsRightSidebarCollapsed((v) => !v)
                      }
                    />

                    <div class="main-area">
                      <MainDocumentView
                        viewKey={mainViewKey}
                        selectedDocUrl={pinnedDocUrl}
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

                  <Show when={hasContextOrTray()}>
                    <ContextSidebar
                      selectedToolId={props.selectedContextToolId}
                      setSelectedToolId={props.setSelectedContextToolId}
                      isCollapsed={props.isRightSidebarCollapsed}
                      width={props.rightSidebarWidth}
                      onMouseDown={props.handleMouseDown}
                      onToggleClick={props.handleToggleClick}
                      onCollapse={() => props.setIsRightSidebarCollapsed(true)}
                    />
                  </Show>
                </div>
              </Show>
            </patchwork-view>
          </patchwork-view>
        </patchwork-view>
      )}
    </Show>
  );
}
