import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { Accessor } from "solid-js";
import { Show } from "solid-js";

interface MainDocumentViewProps {
  viewKey: Accessor<string | undefined>;
  selectedDocUrl: Accessor<AutomergeUrl | undefined>;
  toolId: Accessor<string | undefined>;
  // Stable container ref so callers can observe the view's bubbling
  // `patchwork:mounted` / `patchwork:no-tool` events (see useMainDocMounted).
  ref?: (el: HTMLDivElement) => void;
}

/**
 * Renders the main document view with proper keying for remounting
 */
export function MainDocumentView({
  viewKey,
  selectedDocUrl,
  toolId,
  ref,
}: MainDocumentViewProps) {
  return (
    <div class="document-view" ref={ref}>
      <Show when={viewKey()} keyed>
        {(key) => {
          return (
            <patchwork-view doc-url={selectedDocUrl()!} tool-id={toolId()} />
          );
        }}
      </Show>
      {!selectedDocUrl() && (
        <div class="placeholder">
          Select a document in the sidebar
        </div>
      )}
    </div>
  );
}
