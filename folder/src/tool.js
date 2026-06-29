import {
  parseAutomergeUrl,
  isValidAutomergeUrl,
} from "@automerge/automerge-repo";
import "@inkandswitch/patchwork-elements";
import styles from "./styles.css";

// MIME types we can extract document drags from, in order of preference.
// These mirror what the sideboard sets on dragstart so dropping a sidebar
// item into the folder view adds it to the folder.
const DND_DATA_TYPES = [
  "text/x-patchwork-dnd",
  "text/x-patchwork-urls",
  "text/uri-list",
  "text/plain",
];

function hasDocumentDrag(dataTransfer) {
  return Boolean(
    dataTransfer &&
      DND_DATA_TYPES.some((type) => dataTransfer.types.includes(type))
  );
}

function urlFromText(text) {
  const trimmed = text.trim();
  if (isValidAutomergeUrl(trimmed)) return trimmed;
  // patchwork web links carry the document id in the fragment: #doc=<documentId>
  const docId = trimmed.match(/#doc=([^&\s]+)/)?.[1];
  if (docId && isValidAutomergeUrl(`automerge:${docId}`)) {
    return `automerge:${docId}`;
  }
  return null;
}

// Extract the dragged documents from a drop event. Returns an array of
// { url, name?, type? } items, or an empty array if there's nothing droppable.
function getDndItems(event) {
  const data = event.dataTransfer;
  if (!data) return [];

  const dndData = data.getData("text/x-patchwork-dnd");
  if (dndData) {
    try {
      const parsed = JSON.parse(dndData);
      if (Array.isArray(parsed?.items) && parsed.items.length > 0) {
        return parsed.items.filter((item) => isValidAutomergeUrl(item?.url));
      }
    } catch {
      // fall through to the other types
    }
  }

  const urlData = data.getData("text/x-patchwork-urls");
  if (urlData) {
    try {
      const urls = JSON.parse(urlData);
      const items = (Array.isArray(urls) ? urls : [])
        .filter((url) => isValidAutomergeUrl(url))
        .map((url) => ({ url }));
      if (items.length > 0) return items;
    } catch {
      // fall through to the other types
    }
  }

  const text = data.getData("text/uri-list") || data.getData("text/plain");
  return text
    .split(/\r?\n/)
    .map(urlFromText)
    .filter((url) => url !== null)
    .map((url) => ({ url }));
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "className") {
        node.className = value;
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value);
      }
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(
      typeof child === "string" ? document.createTextNode(child) : child
    );
  }
  return node;
}

function entryHref(docLink) {
  return `#doc=${parseAutomergeUrl(docLink.url).documentId}&type=${docLink.type}`;
}

function renderLoading() {
  return el("div", { className: "folder-view-loading" }, "Loading…");
}

function buildEntry(docLink) {
  const isFolder = docLink.type === "folder";
  const nameEl = el("span", { className: "folder-entry-name" }, docLink.name);
  const typeEl = el("span", { className: "folder-entry-type" }, docLink.type);
  const openEl = el(
    "a",
    { className: "folder-entry-open", href: entryHref(docLink) },
    "Open"
  );

  const node = el(
    "div",
    { className: "folder-entry", "data-type": docLink.type },
    el(
      "div",
      { className: "folder-entry-head" },
      el("div", { className: "folder-entry-title" }, nameEl, typeEl),
      openEl
    ),
    isFolder
      ? el(
          "p",
          { className: "folder-entry-hint" },
          'Click "Open" to view folder contents'
        )
      : el(
          "div",
          { className: "folder-entry-body" },
          el(
            "div",
            { className: "folder-entry-scroll" },
            el("patchwork-view", { "doc-url": docLink.url })
          )
        )
  );

  return { node, nameEl, typeEl, openEl, isFolder };
}

function updateEntry(entry, docLink) {
  if (entry.nameEl.textContent !== docLink.name) {
    entry.nameEl.textContent = docLink.name;
  }
  if (entry.typeEl.textContent !== docLink.type) {
    entry.typeEl.textContent = docLink.type;
  }
  if (entry.node.getAttribute("data-type") !== docLink.type) {
    entry.node.setAttribute("data-type", docLink.type);
  }
  const href = entryHref(docLink);
  if (entry.openEl.getAttribute("href") !== href) {
    entry.openEl.setAttribute("href", href);
  }
}

export const FolderTool = (handle, element) => {
  const entries = new Map();

  const styleEl = el("style");
  styleEl.textContent = styles;

  const countEl = el("span", { className: "folder-view-count" });
  const listEl = el("div", { className: "folder-view-list" });
  const shell = el(
    "div",
    { className: "folder-view" },
    el("div", { className: "folder-view-header" }, countEl),
    listEl
  );

  element.append(styleEl);

  // --- drag-and-drop: accept documents dragged in from the sidebar ---

  // dragenter/dragleave fire for every descendant, so track nesting depth to
  // know when the pointer has actually left the folder view.
  let dragDepth = 0;

  function endDrag() {
    dragDepth = 0;
    shell.removeAttribute("data-drop-active");
  }

  function addDroppedDocs(event) {
    const folder = handle.doc();
    if (!folder) return;

    const existing = new Set(folder.docs.map((docLink) => docLink.url));
    const selfUrl = handle.url;

    const links = [];
    for (const item of getDndItems(event)) {
      if (item.url === selfUrl) continue; // don't nest a folder inside itself
      if (existing.has(item.url)) continue; // already here
      existing.add(item.url); // de-dupe within a single drop too
      links.push({
        url: item.url,
        name: item.name || "Untitled",
        type: item.type || "",
      });
    }

    if (links.length === 0) return;

    handle.change((doc) => {
      doc.docs.push(...links);
    });
  }

  shell.addEventListener("dragenter", (event) => {
    if (!hasDocumentDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth++;
    shell.setAttribute("data-drop-active", "");
  });

  shell.addEventListener("dragover", (event) => {
    if (!hasDocumentDrag(event.dataTransfer)) return;
    event.preventDefault();
    // "link": dropping here adds a new DocLink to the same automerge url — the
    // doc isn't moved or cloned. Requires the source's effectAllowed to permit
    // link (the sideboard sets "all").
    event.dataTransfer.dropEffect = "link";
  });

  shell.addEventListener("dragleave", (event) => {
    if (!hasDocumentDrag(event.dataTransfer)) return;
    dragDepth--;
    if (dragDepth <= 0) endDrag();
  });

  shell.addEventListener("drop", (event) => {
    if (!hasDocumentDrag(event.dataTransfer)) return;
    event.preventDefault();
    endDrag();
    addDroppedDocs(event);
  });

  let mounted = null;

  function show(node) {
    if (mounted !== node) {
      // keep the injected <style>, swap the rendered tree
      if (mounted) mounted.remove();
      element.append(node);
      mounted = node;
    }
  }

  function render() {
    const folder = handle.doc();
    if (!folder) {
      show(renderLoading());
      return;
    }

    show(shell);
    countEl.textContent = `${folder.docs.length} ${
      folder.docs.length === 1 ? "document" : "documents"
    }`;

    if (folder.docs.length === 0) {
      entries.clear();
      listEl.replaceChildren(
        el("div", { className: "folder-view-empty" }, "This folder is empty")
      );
      return;
    }

    const seen = new Set();
    const ordered = [];
    for (const docLink of folder.docs) {
      seen.add(docLink.url);
      const isFolder = docLink.type === "folder";
      let entry = entries.get(docLink.url);
      // Rebuild only if folder/non-folder shape flipped — that's the one
      // case where the body structure differs.
      if (!entry || entry.isFolder !== isFolder) {
        entry = buildEntry(docLink);
        entries.set(docLink.url, entry);
      } else {
        updateEntry(entry, docLink);
      }
      ordered.push(entry.node);
    }

    for (const url of [...entries.keys()]) {
      if (!seen.has(url)) entries.delete(url);
    }

    listEl.replaceChildren(...ordered);
  }

  const onChange = () => render();
  handle.on("change", onChange);
  render();

  return () => {
    handle.off("change", onChange);
    element.replaceChildren();
    entries.clear();
    mounted = null;
  };
};
