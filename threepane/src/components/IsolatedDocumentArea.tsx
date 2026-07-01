/**
 * `IsolatedDocumentArea` — the isolation-mode document area, which mounts a `patchwork:component`
 * inside a sandboxed iframe with isolation root code.
 *
 * The host never builds or mounts the document subtree here. It mounts the
 * `patchwork-isolation` component (from the `@patchwork/isolation` module) via
 * `<patchwork-view component="patchwork-isolation">`. The boot spec rides on that element's DOM:
 * `root-component` / `automerge-allowlist` as attributes and `props` as an inert
 * `<script type="application/json">` child.
 * `mountIsolationRoot` is registered as the `threepane-isolation-root` `patchwork:component`
 * in index.tsx and is what the isolation iframe resolves and mounts. A spec change (attribute or
 * child) reboots the iframe.
 */

import type { AutomergeUrl } from "@automerge/automerge-repo";
import { createMemo, Show } from "solid-js";
import type { ToolSlot } from "../types";
import { render } from "solid-js/web";
import type { DocumentAreaInputs } from "./DocumentAreaRoot";
import { DocumentAreaRoot } from "./DocumentAreaRoot";
import { DEFAULT_SIDEBAR_WIDTH } from "../hooks";
import { ensureFrameStyles } from "../ensureFrameStyles";

// Local JSX augmentation for the isolation-specific attributes carried on
// `<patchwork-view>` when it hosts the `patchwork-isolation` component
// (`root-component` / `automerge-allowlist` / `shared-providers`). These are
// read by the isolation component off the mounted element; they are not part of
// core's `patchwork-view` attribute set, so declare them here rather than
// importing anything from the isolation package (which would be a cross-import).
//
// A same-key redeclaration of an `IntrinsicElements` member *replaces* rather
// than merges, so we must restate the core attributes threepane also uses
// (`component`/`url`/`doc-url`/`tool-id`) alongside the additions, or those
// usages elsewhere (e.g. DocumentAreaRoot) lose their typings.
declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "patchwork-view": HTMLAttributes<HTMLElement> & {
        component?: string;
        url?: string;
        "doc-url"?: string;
        "tool-id"?: string | null;
        "root-component"?: string;
        "automerge-allowlist"?: string;
        // Force-attribute form (Solid `attr:` namespace) for the dynamic value.
        "attr:automerge-allowlist"?: string;
        "shared-providers"?: string;
      };
    }
  }
}

export interface IsolatedDocumentAreaProps extends DocumentAreaInputs {
  /** Add to `rootUrls`  */
  contactUrl: AutomergeUrl | undefined;
}

// Extract the document URL pinned by a tool-slot tuple (`[toolId, docId]`). Bare
// string slots name a component with no document, so they contribute no root.
function slotDocUrl(slot: ToolSlot): AutomergeUrl | undefined {
  return Array.isArray(slot) ? slot[1] : undefined;
}

export function IsolatedDocumentArea(props: IsolatedDocumentAreaProps) {
  // rootUrls: the docs the iframe is allowed to sync. Never the account or
  // threepane-config doc (those stay host-side / denylisted).
  const rootUrls = createMemo<AutomergeUrl[]>(() => {
    const urls = new Set<AutomergeUrl>();
    const selected = props.selectedDocUrl();
    if (selected) urls.add(selected);
    if (props.contactUrl) urls.add(props.contactUrl);
    for (const slot of props.traySlots() ?? []) {
      const u = slotDocUrl(slot);
      if (u) urls.add(u);
    }
    for (const slot of props.contextTabSlots() ?? []) {
      const u = slotDocUrl(slot);
      if (u) urls.add(u);
    }
    return [...urls];
  });

  // The props handed to the isolated root, serialized into the inert JSON child.
  // Structured-clone JSON only (no accessors/handles) — the iframe reads it back
  // in `mountIsolationRoot`.
  const propsJson = createMemo(() =>
    JSON.stringify({
      selectedDocUrl: props.selectedDocUrl(),
      selectedToolId: props.selectedToolId(),
      doctitleSlots: props.doctitleSlots(),
      traySlots: props.traySlots(),
      contextTabIds: props.contextTabIds(),
      contextTabSlots: props.contextTabSlots(),
      isLeftCollapsed: props.isLeftCollapsed(),
      initialRightWidth: props.initialRightWidth(),
      initialRightCollapsed: props.initialRightCollapsed(),
    })
  );

  // TODO(isolation): temporary props-reboot gate. The `patchwork-isolation`
  // component reboots the iframe only when its boot *attributes* change
  // (automerge-allowlist / root-component / shared-providers), and the in-iframe
  // root reads `props` only at mount. So a props-only change with no attribute
  // change (e.g. toggling a collapse flag or reordering tools on the same
  // documents) would otherwise never reach the iframe. Keying the whole
  // `<patchwork-view>` on the serialized props forces a full remount → fresh
  // boot whenever any prop changes, guaranteeing correctness at the cost of a
  // reboot per props change. Remove this `Show` wrapper once isolation supports
  // live props updates (postMessage the new props into the iframe and have the
  // in-iframe root re-read them, instead of rebooting).
  //
  // The `automerge-allowlist` attribute stays a live `attr:` binding inside the
  // mount, so an allowlist change still reboots via the component's own observer
  // — the keyed remount only adds the props-driven path on top.
  return (
    <Show keyed when={propsJson()}>
      {(json) => (
        <patchwork-view
          component="patchwork-isolation"
          // The registered patchwork:component the iframe resolves and mounts
          // inside itself (its load() returns `mountIsolationRoot`). Registered
          // in index.tsx.
          root-component="threepane-isolation-root"
          // `attr:` forces Solid to set a DOM *attribute* (not a JS property) for
          // this dynamic value. The isolation component reads it via
          // `getAttribute("automerge-allowlist")` and its MutationObserver watches
          // the attribute, so a property assignment would be invisible to it.
          attr:automerge-allowlist={rootUrls().join(",")}
          shared-providers="patchwork:contact,patchwork:selected-doc"
          style={{ display: "contents" }}
        >
          <script type="application/json">{json}</script>
        </patchwork-view>
      )}
    </Show>
  );
}

interface IsolationRootProps {
  selectedDocUrl?: AutomergeUrl;
  selectedToolId?: string;
  doctitleSlots?: ToolSlot[];
  traySlots?: ToolSlot[];
  contextTabIds?: string[];
  contextTabSlots?: ToolSlot[];
  isLeftCollapsed?: boolean;
  initialRightWidth?: number;
  initialRightCollapsed?: boolean;
}

/**
 * Mount fn (`(element) => cleanup`) for the isolated document-area root, run
 * inside the iframe. Reads its props from the inert JSON `<script>` child the
 * iframe bootstrap appended, wraps each value in a constant accessor (a real
 * change reboots the iframe), and renders `DocumentAreaRoot`.
 */
export function mountIsolationRoot(element: HTMLElement): () => void {
  // Inject the threepane stylesheet into THIS realm (the iframe).
  ensureFrameStyles();

  // Parse the isolation props
  const script = element.querySelector<HTMLScriptElement>(
    'script[type="application/json"]'
  );
  let p: IsolationRootProps = {};
  if (script?.textContent) {
    try {
      p = JSON.parse(script.textContent) as IsolationRootProps;
    } catch (err) {
      console.error("[threepane-isolation-root] bad props JSON:", err);
    }
  }

  // Wrap in a `.frame` like the PatchworkFrame host: the threepane stylesheet's
  // rules are authored nested under `.frame {`, so the document-area markup only
  // picks them up inside a `.frame` ancestor. The props <script> sibling is left
  // untouched. `render` mounts alongside it and its disposer tears the tree down.
  return render(
    () => (
      <div class="frame">
        <DocumentAreaRoot
          selectedDocUrl={() => p.selectedDocUrl}
          selectedToolId={() => p.selectedToolId}
          doctitleSlots={() => p.doctitleSlots}
          traySlots={() => p.traySlots}
          contextTabIds={() => p.contextTabIds}
          contextTabSlots={() => p.contextTabSlots}
          isLeftCollapsed={() => p.isLeftCollapsed ?? false}
          initialRightWidth={() => p.initialRightWidth ?? DEFAULT_SIDEBAR_WIDTH}
          initialRightCollapsed={() => p.initialRightCollapsed ?? false}
        />
      </div>
    ),
    element
  );
}
