import { createSignal } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";

// A "new document" drag (or click) is asking for a doc to be created inside the
// folder at `containerUrl`, inserted at `index`. The DocumentList whose handle
// matches `containerUrl` renders a placeholder row + type picker there.
export const [pendingNewDoc, setPendingNewDoc] = createSignal<{
  containerUrl: AutomergeUrl;
  index: number;
} | null>(null);

export function filterMatches(filter: string, string?: string) {
  const lower = string?.toLowerCase();
  return (
    !!lower &&
    filter
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => lower.includes(term))
  );
}

export const [renaming, setRenaming] = createSignal("");

// The set of folder URLs that lie on the path from the root to a currently
// selected document. A folder reads this to auto-expand itself so the selected
// doc is revealed, even when it sits in a deeply nested (and otherwise
// unmounted) subtree. Computed by the panel whenever the selection changes; see
// collectExpandedFolders in document-list/auto-expand.ts.
export const [autoExpandedFolders, setAutoExpandedFolders] = createSignal<
  Set<AutomergeUrl>
>(new Set());
