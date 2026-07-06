import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import {
  type AutomergeUrl,
  type DocumentId,
  isValidDocumentId,
  parseAutomergeUrl,
} from "@automerge/automerge-repo";
import { embedTheme } from "../themes/embed.ts";
import { openLinkIcon } from "./icons.ts";
import { getDocumentDragPayload } from "./dnd.ts";

/**
 * Widget to render an embedded <patchwork-view> element in a CodeMirror editor.
 */
class EmbedWidget extends WidgetType {
  readonly docId: DocumentId;
  // `null` means "no explicit tool": <patchwork-view> falls back to the
  // default tool registered for the document's datatype.
  readonly toolId: string | null;
  readonly embedText: string;

  constructor(docId: DocumentId, toolId: string | null, embedText: string) {
    super();
    this.docId = docId;
    this.toolId = toolId;
    this.embedText = embedText;
  }

  eq(other: EmbedWidget) {
    return other.docId === this.docId && other.toolId === this.toolId;
  }

  toDOM() {
    const container = document.createElement("div");
    container.className = "cm-embed";

    const label = document.createElement("div");
    label.className = "cm-embed-label";

    const labelText = document.createElement("span");
    labelText.className = "cm-embed-label-text";
    labelText.textContent = this.embedText;
    labelText.title = "Click to edit";

    const openLink = document.createElement("button");
    openLink.className = "cm-embed-open-link";
    openLink.title = "Open document";
    openLink.innerHTML = openLinkIcon;

    openLink.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const params = new URLSearchParams();
      params.set("doc", this.docId);
      // Tool-less embeds open with the datatype's default tool.
      if (this.toolId) params.set("tool", this.toolId);
      window.location.hash = params.toString();
    };

    label.appendChild(labelText);
    label.appendChild(openLink);

    const view = document.createElement("patchwork-view");
    // Name the doc without heads. Resolution (OverlayRepo + the drafts
    // `repo:handle-descriptor` answer) pins it to the active checkpoint when one
    // is checked out, so the embed freezes with the document it lives in;
    // otherwise it renders live.
    view.setAttribute("doc-url", `automerge:${this.docId}`);
    if (this.toolId) view.setAttribute("tool-id", this.toolId);
    // The <patchwork-view> needs an explicit, non-zero height set inline:
    // without it the element collapses to 0px and the embedded tool never
    // renders. (The stylesheet rule isn't reliably applied here, so we set it
    // directly on the element.)
    view.style.display = "block";
    view.style.height = "500px";
    view.style.width = "100%";

    container.appendChild(label);
    container.appendChild(view);

    return container;
  }

  ignoreEvent(e: Event) {
    if (e.type === "mousedown" && e.target instanceof Element) {
      // Allow clicks on the label text to pass through for editing
      if (e.target.classList.contains("cm-embed-label-text")) {
        return false; // Let the editor handle it
      }
      // Block clicks on the open link button (let button handle it)
      if (
        e.target.classList.contains("cm-embed-open-link") ||
        e.target.closest(".cm-embed-open-link")
      ) {
        return true; // Block from editor
      }
    }
    // Block other events from reaching the editor (let patchwork-view handle them)
    return true;
  }
}

// Embed marker syntax: [patchwork:docId] or [patchwork:docId/toolId]. The tool
// id is optional; when absent the embed falls back to the datatype's default
// tool. The doc id / tool id cannot contain `/` or `]`.
//
// We scan the document text directly rather than walking the markdown syntax
// tree on purpose: `@codemirror/language` is not a shared singleton across
// patchwork's separately-bundled CodeMirror extensions, so `syntaxTree(state)`
// here reads a different `Language` facet than the markdown tool populates and
// always comes back empty. Plain-text scanning keeps this extension
// self-contained and free of any `@codemirror/language` dependency.
const EMBED_PATTERN = /\[patchwork:([^/\]]+)(?:\/([^\]]+))?\]/g;

function getEmbedLinks(view: EditorView) {
  const widgets: Range<Decoration>[] = [];
  const { state } = view;
  const selection = state.selection.main;

  // Scan only the visible ranges. Markers never span a line break, and
  // CodeMirror's visible ranges are line-aligned, so a marker is either fully
  // inside a range or fully outside it.
  for (const { from, to } of view.visibleRanges) {
    const text = state.doc.sliceString(from, to);
    EMBED_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMBED_PATTERN.exec(text)) !== null) {
      const matchFrom = from + m.index;
      const matchTo = matchFrom + m[0].length;
      const [matchText, docId, toolId] = m;

      // Show raw text (no widget) while the cursor is on the marker or a
      // selection spans it, so it can be edited.
      const cursorInLink =
        selection.from >= matchFrom && selection.from <= matchTo;
      const selectionSpansLink =
        selection.from < matchFrom && selection.to > matchTo;
      if (cursorInLink || selectionSpansLink) continue;

      if (!isValidDocumentId(docId)) continue;

      const embed = Decoration.replace({
        widget: new EmbedWidget(docId as DocumentId, toolId ?? null, matchText),
      });
      widgets.push(embed.range(matchFrom, matchTo));
    }
  }

  // `true` lets CodeMirror sort the ranges defensively (matches are already in
  // document order, but this is cheap insurance).
  return Decoration.set(widgets, true);
}

// Drag MIME types that unambiguously identify a patchwork document drag, safe
// to claim during `dragover`. Deliberately narrower than the payload types
// `getDocumentDragPayload` reads on drop: plain `text/uri-list`/`text/plain`
// can be an ordinary in-editor text drag, which we must not swallow. (`Files`
// covers OS drags, whose `dt.files` is empty until drop.)
const UNAMBIGUOUS_DRAG_TYPES = [
  "Files",
  "text/x-patchwork-dnd",
  "text/x-patchwork-urls",
];

/**
 * Import each OS file dropped from the desktop as a Patchwork `file` document,
 * returning the ids to embed. Uses the realm-local `window.repo` (the
 * documented global) — fine for creating brand-new docs, which aren't subject
 * to draft remapping.
 */
async function fileDropDocIds(files: FileList): Promise<DocumentId[]> {
  const repo = (window as unknown as { repo?: any }).repo;
  if (!repo) {
    console.warn(
      "[codemirror-embed] window.repo unavailable; ignoring dropped files"
    );
    return [];
  }
  const docIds: DocumentId[] = [];
  for (const file of Array.from(files)) {
    try {
      const mimeType = file.type || "application/octet-stream";
      const isText =
        mimeType.startsWith("text/") || mimeType === "application/json";
      const content = isText
        ? await file.text()
        : new Uint8Array(await file.arrayBuffer());
      const parts = file.name.split(".");
      const extension = parts.length > 1 ? parts.pop()! : "";
      const handle = repo.create();
      handle.change((d: any) => {
        d["@patchwork"] = { type: "file" };
        d.content = content;
        d.mimeType = mimeType;
        d.extension = extension;
        d.name = file.name;
      });
      const { documentId } = parseAutomergeUrl(handle.url as AutomergeUrl);
      if (isValidDocumentId(documentId)) {
        docIds.push(documentId as DocumentId);
      }
    } catch (err) {
      console.warn(
        "[codemirror-embed] failed to import dropped file",
        file.name,
        err
      );
    }
  }
  return docIds;
}

// Insert `[patchwork:docId]` embeds at `pos`, on their own line(s), leaving
// the cursor on a fresh line *after* them. The trailing newline is essential:
// if the cursor stays adjacent to an embed, `getEmbedLinks` treats it as
// "being edited" and shows the raw `[patchwork:…]` text instead of the widget.
function insertEmbeds(
  view: EditorView,
  pos: number,
  docIds: readonly DocumentId[]
): void {
  if (docIds.length === 0) return;
  const inserts = docIds.map((docId) => `[patchwork:${docId}]`);
  const line = view.state.doc.lineAt(pos);
  const beforeOnLine = line.text.slice(0, pos - line.from);
  const prefix = beforeOnLine.trim() === "" ? "" : "\n";
  const text = `${prefix}${inserts.join("\n\n")}\n`;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    scrollIntoView: true,
  });
}

/**
 * Drop handler that accepts:
 *  - documents dragged from the sideboard (or any other patchwork drag
 *    source), read following the drag-and-drop recipe via
 *    `getDocumentDragPayload` — `text/x-patchwork-dnd`,
 *    `text/x-patchwork-urls`, `text/uri-list`, then `text/plain` — and
 *  - files dragged in from the operating system (imported as `file` docs).
 * Inserts a `[patchwork:docId]` embed per document at the drop position.
 *
 * The tool id is intentionally omitted: the drag payload's `type` is a
 * datatype rather than a tool id, so the embed falls back to the datatype's
 * default tool when rendered by <patchwork-view>.
 */
function embedDropHandlers() {
  return EditorView.domEventHandlers({
    dragover(event) {
      // dragover only exposes the data *types*, not their values, so we can
      // only check presence here — the actual payload is read on drop. Claim
      // only unambiguous drags so ordinary text drags stay with the editor.
      const dt = event.dataTransfer;
      if (!dt || !UNAMBIGUOUS_DRAG_TYPES.some((t) => dt.types.includes(t))) {
        return false;
      }
      event.preventDefault(); // REQUIRED, or the browser refuses the drop
      dt.dropEffect = "copy";
      return true;
    },
    drop(event, view) {
      const dt = event.dataTransfer;
      if (!dt) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;

      // OS files import asynchronously; insert once the docs exist.
      if (dt.files && dt.files.length > 0) {
        event.preventDefault();
        void fileDropDocIds(dt.files).then((docIds) =>
          insertEmbeds(view, pos, docIds)
        );
        return true;
      }

      // Otherwise only handle the drop if it actually resolves to patchwork
      // docs (dnd/urls always do; uri-list/plain only for patchwork links).
      // If not, let CodeMirror handle it as a normal text drop.
      const items = getDocumentDragPayload(dt);
      if (!items || items.length === 0) return false;

      const docIds: DocumentId[] = [];
      for (const item of items) {
        const { documentId } = parseAutomergeUrl(item.url);
        if (isValidDocumentId(documentId)) docIds.push(documentId);
      }
      if (docIds.length === 0) return false;

      event.preventDefault();
      insertEmbeds(view, pos, docIds);
      return true;
    },
  });
}

const embedPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = getEmbedLinks(view);
    }

    update(update: ViewUpdate) {
      // Recompute when the document changes, the selection moves, or the
      // viewport scrolls (so newly-visible markers get decorated).
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = getEmbedLinks(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

export function markdownEmbed() {
  return [embedPlugin, embedTheme, embedDropHandlers()];
}
