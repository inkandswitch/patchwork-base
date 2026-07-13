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
