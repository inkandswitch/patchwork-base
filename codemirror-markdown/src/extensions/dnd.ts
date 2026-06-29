import {
  isValidAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";

// One document referenced by a drag. Only `url` is required; everything else
// is advisory metadata a producer may attach (see the drag-and-drop recipe).
export type DocumentDragItem = {
  id?: string;
  url: AutomergeUrl;
  name?: string;
  type?: string;
};

// MIME types a patchwork document drag may arrive under, richest first. A
// producer writes as many as it can; we read the first one we understand.
const DOCUMENT_DRAG_TYPES = [
  "text/x-patchwork-dnd",
  "text/x-patchwork-urls",
  "text/uri-list",
  "text/plain",
];

// True if the drag carries any payload we know how to read as documents. Safe
// to call during `dragover`, where only the data *types* are readable.
export function hasDocumentDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(
    dataTransfer &&
      DOCUMENT_DRAG_TYPES.some((type) => dataTransfer.types.includes(type))
  );
}

// Extract the dragged documents, reading the MIME types in order of richness
// and stopping at the first that yields at least one valid Automerge url.
// Returns null when the drag carries no resolvable document.
export function getDocumentDragPayload(
  dataTransfer: DataTransfer | null
): DocumentDragItem[] | null {
  if (!dataTransfer) return null;

  // 1. Rich payload: { source, items: [{ id?, url, name?, type? }] }.
  const rich = dataTransfer.getData("text/x-patchwork-dnd");
  if (rich) {
    try {
      const parsed = JSON.parse(rich) as { items?: DocumentDragItem[] };
      const items = (parsed.items ?? []).filter((item) =>
        isValidAutomergeUrl(item?.url)
      );
      if (items.length) return items;
    } catch {
      // fall through to the next type
    }
  }

  // 2. JSON array of Automerge urls.
  const urls = dataTransfer.getData("text/x-patchwork-urls");
  if (urls) {
    try {
      const list = JSON.parse(urls) as unknown[];
      const items = (Array.isArray(list) ? list : [])
        .filter((url): url is AutomergeUrl => isValidAutomergeUrl(url))
        .map((url) => ({ url }));
      if (items.length) return items;
    } catch {
      // fall through to the next type
    }
  }

  // 3. Newline-separated urls / web links (text/uri-list, then text/plain).
  const text =
    dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
  const items = text
    .split(/\r?\n/)
    .map(urlFromText)
    .filter((url): url is AutomergeUrl => url !== null)
    .map((url) => ({ url }));
  return items.length ? items : null;
}

// Resolve a single line of text to an Automerge url: either a bare
// `automerge:…` url or a patchwork web link carrying `#doc=<documentId>`.
function urlFromText(text: string): AutomergeUrl | null {
  const trimmed = text.trim();
  if (isValidAutomergeUrl(trimmed)) return trimmed;
  const docId = trimmed.match(/#doc=([^&\s]+)/)?.[1];
  if (docId && isValidAutomergeUrl(`automerge:${docId}`)) {
    return `automerge:${docId}` as AutomergeUrl;
  }
  return null;
}
