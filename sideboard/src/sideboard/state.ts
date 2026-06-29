import { createSignal } from "solid-js";
import type { AutomergeUrl } from "@automerge/automerge-repo";

export const [filter, setFilter] = createSignal("");

// A "new document" drag (or click) is asking for a doc to be created inside the
// folder at `containerUrl`, inserted at `index`. The DocumentList whose handle
// matches `containerUrl` renders a placeholder row + type picker there.
export const [pendingNewDoc, setPendingNewDoc] = createSignal<{
  containerUrl: AutomergeUrl;
  index: number;
} | null>(null);

export function filterMatches(string: string) {
  const lower = string?.toLowerCase();
  return !!lower && filter().split(/\s+/).filter(Boolean).every(term => lower.includes(term));
}

export const [renaming, setRenaming] = createSignal("");
