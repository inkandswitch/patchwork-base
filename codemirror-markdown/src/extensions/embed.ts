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

// `[patchwork:docId]` or `[patchwork:docId/toolId]` — ids may not contain `]`
// or `/`. The `/toolId` part is optional; without it the embed falls back to
// the document's default tool for its datatype (see LegacyImpl).
const EMBED_RE = /\[patchwork:([^/\]]+)(?:\/([^\]]+))?\]/;

/**
 * Widget to render an embedded <patchwork-view> element in a CodeMirror editor.
 */
class EmbedWidget extends WidgetType {
  readonly docId: DocumentId;
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
    view.setAttribute("doc-url", `automerge:${this.docId}`);
    if (this.toolId) view.setAttribute("tool-id", this.toolId);

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
          widget: new EmbedWidget(docId as DocumentId, toolId ?? null, linkText),
        });
        widgets.push(embed.range(linkFrom, linkTo));
      },
    });
  }

  return Decoration.set(widgets, true);
}

// MIME types we accept document drags from. Mirrors the sideboard's convention
// (duplicated on purpose — see the DnD notes; a shared package is a later step).
const PATCHWORK_DND = "text/x-patchwork-dnd";
const PATCHWORK_URLS = "text/x-patchwork-urls";

type DocRef = { docId: DocumentId; toolId: string | null };

/** Turn an automerge url or a patchwork web link into a DocumentId, or null. */
function urlToDocId(raw: string): DocumentId | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Plain automerge url (optionally carrying heads/query/subpath).
  const am = trimmed.match(/automerge:([a-zA-Z0-9]+)/);
  if (am && isValidDocumentId(am[1])) return am[1] as DocumentId;
  // Patchwork web link: #doc=<documentId> (also &doc= / ?doc=).
  const web = trimmed.match(/[#&?]doc=([a-zA-Z0-9]+)/);
  if (web && isValidDocumentId(web[1])) return web[1] as DocumentId;
  return null;
}

/**
 * Read dragged documents out of a drop event, in order of format preference.
 * Only an *explicit* `toolId` on a structured item pins the tool; otherwise we
 * embed tool-less and let the view fall back to the datatype's default tool.
 * (The previous code mis-read `item.type` — a datatype — as a tool id, so any
 * source whose datatype != tool id produced a broken embed, and sources that
 * set only urls were dropped entirely.)
 */
function extractDocRefs(dt: DataTransfer): DocRef[] {
  const refs: DocRef[] = [];
  const seen = new Set<string>();
  const push = (docId: DocumentId | null, toolId: string | null) => {
    if (!docId || seen.has(docId)) return;
    seen.add(docId);
    refs.push({ docId, toolId });
  };

  const dnd = dt.getData(PATCHWORK_DND);
  if (dnd) {
    try {
      const parsed = JSON.parse(dnd) as {
        items?: Array<{ url?: string; toolId?: string }>;
      };
      for (const item of parsed?.items ?? []) {
        if (item?.url) push(urlToDocId(item.url), item.toolId ?? null);
      }
    } catch {
      // fall through to the other formats
    }
  }
  if (refs.length > 0) return refs;

  const urls = dt.getData(PATCHWORK_URLS);
  if (urls) {
    try {
      const parsed: unknown = JSON.parse(urls);
      if (Array.isArray(parsed)) {
        for (const u of parsed) push(urlToDocId(String(u)), null);
      }
    } catch {
      // fall through
    }
  }
  if (refs.length > 0) return refs;

  const text = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (text) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) continue; // uri-list comments
      push(urlToDocId(line), null);
    }
  }
  return refs;
}

function embedSyntax({ docId, toolId }: DocRef): string {
  return toolId ? `[patchwork:${docId}/${toolId}]` : `[patchwork:${docId}]`;
}

/**
 * Import each OS file dropped from the desktop as a Patchwork `file` document,
 * returning tool-less refs to embed. Uses the realm-local `window.repo` (the
 * documented global) — fine for creating brand-new docs, which aren't subject
 * to draft remapping.
 */
async function fileDropRefs(files: FileList): Promise<DocRef[]> {
  const repo = (window as unknown as { repo?: any }).repo;
  if (!repo) {
    console.warn(
      "[codemirror-embed] window.repo unavailable; ignoring dropped files"
    );
    return [];
  }
  const refs: DocRef[] = [];
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
        refs.push({ docId: documentId as DocumentId, toolId: null });
      }
    } catch (err) {
      console.warn(
        "[codemirror-embed] failed to import dropped file",
        file.name,
        err
      );
    }
  }
  return refs;
}

function insertRefs(view: EditorView, pos: number, refs: DocRef[]): void {
  if (refs.length === 0) return;
  const text = refs.map(embedSyntax).join("\n\n");
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

/**
 * Drop handler that accepts:
 *  - documents dragged from the sidebar / canvases / other tools
 *    (`text/x-patchwork-dnd`, `text/x-patchwork-urls`, `text/uri-list`, and
 *    `text/plain` patchwork links), and
 *  - files dragged in from the operating system (imported as `file` docs).
 * Inserts `[patchwork:docId]` (or `[patchwork:docId/toolId]`) at the drop point.
 */
function embedDropHandlers() {
  // Only claim the *dragover* for unambiguous patchwork/OS drags — plain
  // text/uri-list can be an ordinary in-editor text drag, which we must not
  // swallow. (`Files` covers OS drags, whose `dt.files` is empty until drop.)
  const wantsDragover = (dt: DataTransfer | null): boolean =>
    !!dt &&
    (dt.types.includes("Files") ||
      dt.types.includes(PATCHWORK_DND) ||
      dt.types.includes(PATCHWORK_URLS));

  return EditorView.domEventHandlers({
    dragover(event) {
      if (!wantsDragover(event.dataTransfer)) return false;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
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
        void fileDropRefs(dt.files).then((refs) => insertRefs(view, pos, refs));
        return true;
      }

      // Otherwise only handle the drop if it actually resolves to patchwork
      // docs (dnd/urls always do; uri-list/plain only for patchwork links).
      // If not, let CodeMirror handle it as a normal text drop.
      const refs = extractDocRefs(dt);
      if (refs.length === 0) return false;
      event.preventDefault();
      insertRefs(view, pos, refs);
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
