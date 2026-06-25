import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import {
  type AutomergeUrl,
  type DocumentId,
  isValidDocumentId,
  parseAutomergeUrl,
} from "@automerge/automerge-repo";
import { embedTheme } from "../themes/embed.ts";

const openLinkIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
  <polyline points="15 3 21 3 21 9"></polyline>
  <line x1="10" y1="14" x2="21" y2="3"></line>
</svg>`;

// `[patchwork:docId/toolId]` — neither id may contain `]` or `/`.
const EMBED_RE = /\[patchwork:([^/\]]+)\/([^\]]+)\]/;

/**
 * Widget to render an embedded <patchwork-view> element in a CodeMirror editor.
 */
class EmbedWidget extends WidgetType {
  readonly docId: DocumentId;
  readonly toolId: string;
  readonly embedText: string;

  constructor(docId: DocumentId, toolId: string, embedText: string) {
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
      params.set("tool", this.toolId);
      window.location.hash = params.toString();
    };

    label.appendChild(labelText);
    label.appendChild(openLink);

    const view = document.createElement("patchwork-view");
    view.setAttribute("doc-url", `automerge:${this.docId}`);
    view.setAttribute("tool-id", this.toolId);

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

function getEmbedLinks(view: EditorView) {
  const widgets: Range<Decoration>[] = [];
  const { state } = view;
  const selection = state.selection.main;

  // Drive off the markdown syntax tree: only `Link` nodes (`[patchwork:…]`)
  // become embeds, so matches inside code blocks / inline code -- which never
  // parse as links -- are left as raw text. This relies on the markdown
  // language being in the same `@codemirror/language` instance, which holds
  // because this extension ships in the same bundle as the markdown parser.
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Link") return;

        const linkFrom = node.from;
        const linkTo = node.to;

        // Keep the raw text editable when the caret is inside the link, or when
        // the selection spans across it.
        const cursorInLink =
          selection.from >= linkFrom && selection.from <= linkTo;
        const selectionSpansLink =
          selection.from < linkFrom && selection.to > linkTo;
        if (cursorInLink || selectionSpansLink) return;

        const linkText = state.doc.sliceString(linkFrom, linkTo);
        const match = linkText.match(EMBED_RE);
        if (!match) return;

        const [, docId, toolId] = match;
        if (!isValidDocumentId(docId)) return;

        const embed = Decoration.replace({
          widget: new EmbedWidget(docId as DocumentId, toolId, linkText),
        });
        widgets.push(embed.range(linkFrom, linkTo));
      },
    });
  }

  return Decoration.set(widgets, true);
}

/** MIME type used by the sideboard (and similar) for document drag-and-drop. */
const PATCHWORK_DND = "text/x-patchwork-dnd";

/**
 * Drop handler that accepts documents dragged from the sidebar (or elsewhere)
 * using text/x-patchwork-dnd. Inserts [patchwork:docId/toolId] at the drop position.
 */
function embedDropHandlers() {
  return EditorView.domEventHandlers({
    dragover(event) {
      if (!event.dataTransfer?.types.includes(PATCHWORK_DND)) return false;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      return true;
    },
    drop(event, view) {
      if (!event.dataTransfer?.types.includes(PATCHWORK_DND)) return false;
      const raw = event.dataTransfer.getData(PATCHWORK_DND);
      if (!raw) return false;
      try {
        const data = JSON.parse(raw) as {
          items?: Array<{ url?: string; type?: string }>;
        };
        const items = data?.items;
        if (!Array.isArray(items) || items.length === 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const inserts: string[] = [];
        for (const item of items) {
          const url = item?.url;
          const toolId = item?.type;
          if (!url || !toolId) continue;
          const { documentId } = parseAutomergeUrl(url as AutomergeUrl);
          if (!isValidDocumentId(documentId)) continue;
          inserts.push(`[patchwork:${documentId}/${toolId}]`);
        }
        if (inserts.length === 0) return false;
        event.preventDefault();
        const text = inserts.join("\n\n");
        view.dispatch({
          changes: { from: pos, insert: text },
          selection: { anchor: pos + text.length },
        });
        return true;
      } catch {
        return false;
      }
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
      // Recompute when doc changes, selection moves, the viewport changes, or
      // the parse advances (so embeds appear as the markdown tree fills in).
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
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
