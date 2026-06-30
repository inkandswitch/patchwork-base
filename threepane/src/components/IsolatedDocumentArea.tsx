/**
 * `IsolatedDocumentArea` — the isolation-mode document area, which mounts a `patchwork:component`
 * inside a sandboxed iframe with isolation root code.
 *
 * The host never builds or mounts the document subtree here. It renders only a
 * `<patchwork-isolation>` controller and hands it a serializable boot spec. `mountIsolationRoot`
 * is registered as the `threepane-isolation-root` `patchwork:component` in index.tsx.
 * Inside the sandboxed iframe the isolation element mounts that component, calling this fn as
 * `(element) => cleanup`. A spec change (including a change to `rootUrls`) reboots the iframe.
 */

import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { PatchworkIsolationElement } from "@inkandswitch/patchwork-elements";
import { createEffect, createMemo } from "solid-js";
import type { ToolSlot } from "../types";
import { render } from "solid-js/web";
import type { DocumentAreaInputs } from "./DocumentAreaRoot";
import { DocumentAreaRoot } from "./DocumentAreaRoot";
import { DEFAULT_SIDEBAR_WIDTH } from "../hooks";
import { ensureFrameStyles } from "../ensureFrameStyles";

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
  let isolationEl!: PatchworkIsolationElement;

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

  createEffect(() => {
    const spec = {
      // The iframe mounts this registered patchwork:component (its load() returns
      // the mount fn from IsolationRoot.tsx). Registered in index.tsx.
      rootComponentId: "threepane-isolation-root",
      props: {
        selectedDocUrl: props.selectedDocUrl(),
        selectedToolId: props.selectedToolId(),
        doctitleSlots: props.doctitleSlots(),
        traySlots: props.traySlots(),
        contextTabIds: props.contextTabIds(),
        contextTabSlots: props.contextTabSlots(),
        isLeftCollapsed: props.isLeftCollapsed(),
        initialRightWidth: props.initialRightWidth(),
        initialRightCollapsed: props.initialRightCollapsed(),
      },
      rootUrls: rootUrls(),
    };
    isolationEl.configure(spec);
  });

  return (
    <patchwork-isolation
      ref={isolationEl}
      shared-providers="patchwork:contact,patchwork:selected-doc"
      style={{ display: "contents" }}
    />
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
