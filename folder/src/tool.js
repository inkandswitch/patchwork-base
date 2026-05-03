import { parseAutomergeUrl } from "@automerge/automerge-repo";
import "@inkandswitch/patchwork-elements";

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
  return el(
    "div",
    { className: "flex items-center justify-center h-full p-4" },
    el("span", { className: "loading loading-spinner loading-md" })
  );
}

function buildEntry(docLink) {
  const isFolder = docLink.type === "folder";
  const nameEl = el("span", { className: "font-medium" }, docLink.name);
  const typeEl = el(
    "span",
    { className: "badge badge-sm badge-outline ml-2" },
    docLink.type
  );
  const openEl = el(
    "a",
    { className: "btn btn-link btn-sm", href: entryHref(docLink) },
    "Open"
  );

  const node = el(
    "div",
    { className: "card card-bordered bg-base-100 shadow-sm" },
    el(
      "div",
      { className: "card-body p-3 max-h-[300px] flex flex-col" },
      el(
        "div",
        { className: "flex items-center justify-between" },
        el(
          "div",
          { className: "flex items-center gap-2" },
          el("div", null, nameEl, typeEl)
        ),
        openEl
      ),
      isFolder
        ? el(
            "div",
            { className: "text-sm text-base-content/60 mt-1" },
            'Click "Open" to view folder contents'
          )
        : el(
            "div",
            { className: "flex-1 min-h-0" },
            el(
              "div",
              { className: "h-full overflow-auto" },
              el("patchwork-view", { "doc-url": docLink.url })
            )
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
  const href = entryHref(docLink);
  if (entry.openEl.getAttribute("href") !== href) {
    entry.openEl.setAttribute("href", href);
  }
}

export const FolderTool = (handle, element) => {
  const entries = new Map();

  const countEl = el("span", { className: "badge badge-ghost" });
  const listEl = el("div", {
    className: "flex flex-col gap-3 overflow-y-auto flex-1 pb-4",
  });
  const shell = el(
    "div",
    { className: "p-4 h-full overflow-hidden flex flex-col gap-4" },
    el(
      "div",
      {
        className:
          "flex justify-end items-center border-b border-base-300 pb-2",
      },
      countEl
    ),
    listEl
  );

  let mounted = null;

  function show(node) {
    if (mounted !== node) {
      element.replaceChildren(node);
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
    countEl.textContent = `${folder.docs.length} documents`;

    if (folder.docs.length === 0) {
      entries.clear();
      listEl.replaceChildren(
        el(
          "div",
          { className: "text-center text-base-content/60 py-8" },
          "This folder is empty"
        )
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
