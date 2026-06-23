import { parseAutomergeUrl } from "@automerge/automerge-repo";
import "@inkandswitch/patchwork-elements";
import styles from "./styles.css";

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
