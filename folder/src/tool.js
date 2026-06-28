import {
  parseAutomergeUrl,
  isValidAutomergeUrl,
} from "@automerge/automerge-repo";
import { openDocument } from "@inkandswitch/patchwork-elements";
import {
  getRegistry,
  createDocOfDatatype2,
} from "@inkandswitch/patchwork-plugins";
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

// The listable document types, sorted by name. `file` and other unlisted
// datatypes are hidden — you can't create an empty File, for instance.
function listableDatatypes() {
  return getRegistry("patchwork:datatype")
    .all()
    .filter((datatype) => !datatype.unlisted)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Create a fresh document of the given datatype and return a DocLink for it.
// Mirrors the sideboard's createNew: load the plugin on demand, create the doc,
// register it with the sync server (if a hive is present), then read its title.
async function createDocLink(repo, hive, datatype) {
  const loaded = await getRegistry("patchwork:datatype").load(datatype.id);
  if (!loaded) throw new Error(`couldn't load datatype "${datatype.id}"`);
  const docHandle = await createDocOfDatatype2(loaded, repo);
  if (hive) await hive.addSyncServerPullToDoc(docHandle.url);
  return {
    url: docHandle.url,
    name: loaded.module.getTitle(docHandle.doc()),
    type: datatype.id,
  };
}

// The "New" button plus its type-picker popover. Creating a doc appends a
// DocLink to the folder and opens it. Returns { node, dispose }.
function buildCreateNew(handle, element) {
  const menu = el("div", { className: "folder-create-menu", hidden: "" });
  const button = el(
    "button",
    {
      className: "folder-create-button",
      type: "button",
      "aria-label": "Create new document",
    },
    el("span", { className: "folder-create-icon" }, "+"),
    "New"
  );
  const node = el("div", { className: "folder-create" }, button, menu);

  let open = false;

  function setOpen(next) {
    open = next;
    if (open) {
      renderMenu();
      menu.removeAttribute("hidden");
      node.setAttribute("data-open", "");
    } else {
      menu.setAttribute("hidden", "");
      node.removeAttribute("data-open");
    }
  }

  function renderMenu() {
    const datatypes = listableDatatypes();
    if (datatypes.length === 0) {
      menu.replaceChildren(
        el(
          "div",
          { className: "folder-create-empty" },
          "No document types available"
        )
      );
      return;
    }
    menu.replaceChildren(
      ...datatypes.map((datatype) =>
        el(
          "button",
          {
            className: "folder-create-item",
            type: "button",
            onClick: () => pick(datatype),
          },
          datatype.name
        )
      )
    );
  }

  async function pick(datatype) {
    setOpen(false);
    const repo = element.repo;
    if (!repo) return;
    try {
      const link = await createDocLink(repo, element.hive, datatype);
      handle.change((doc) => {
        doc.docs.push(link);
      });
      openDocument(element, link.url);
    } catch (error) {
      console.error("folder: couldn't create document", error);
    }
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!open);
  });

  // Dismiss the menu on an outside click or Escape.
  const onPointerDown = (event) => {
    if (open && !node.contains(event.target)) setOpen(false);
  };
  const onKeyDown = (event) => {
    if (open && event.key === "Escape") setOpen(false);
  };
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);

  const dispose = () => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
  };

  return { node, dispose };
}

export const FolderTool = (handle, element) => {
  const entries = new Map();

  const styleEl = el("style");
  styleEl.textContent = styles;

  const countEl = el("span", { className: "folder-view-count" });
  const listEl = el("div", { className: "folder-view-list" });
  const createNew = buildCreateNew(handle, element);
  const shell = el(
    "div",
    { className: "folder-view" },
    el(
      "div",
      { className: "folder-view-header" },
      createNew.node,
      countEl
    ),
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
    createNew.dispose();
    element.replaceChildren();
    entries.clear();
    mounted = null;
  };
};
