import { getType } from "@inkandswitch/patchwork-filesystem";
import { getRegistry } from "@inkandswitch/patchwork-plugins";

const cssURL = new URL("./styles.css", import.meta.url);
const link = document.createElement("link");
link.rel = "stylesheet";
link.href = cssURL.href;
document.head.appendChild(link);

export default function renderAddDocToSidebarButton(handle, element) {
  const wrapper = document.createElement("div");
  wrapper.className = "add-doc-to-sidebar";

  const button = document.createElement("button");
  button.textContent = "Add to sidebar";
  wrapper.appendChild(button);

  // hidden by default until we confirm there's a datatype
  wrapper.style.display = "none";

  let docDatatypeId;
  let title;

  function update() {
    const doc = handle.doc();
    if (!doc) return;

    docDatatypeId = getType(doc);
    if (!docDatatypeId) {
      wrapper.style.display = "none";
      return;
    }

    const registry = getRegistry("patchwork:datatype");
    const loaded = registry.get(docDatatypeId);
    if (loaded && "module" in loaded) {
      title = loaded.module.getTitle(doc) || undefined;
    }

    wrapper.style.display = "";
  }

  async function onAddDocToSidebar() {
    const repo = element.repo;

    // hack: get reference to the account doc handle through window
    const accountDocHandle = window.accountDocHandle;

    const rootFolderDocHandle = await repo.find(
      accountDocHandle.doc().rootFolderUrl
    );

    rootFolderDocHandle.change((doc) => {
      doc.docs.unshift({
        name: title ?? "Untitled",
        url: handle.url,
        type: docDatatypeId,
      });
    });
  }

  button.addEventListener("click", onAddDocToSidebar);
  handle.on("change", update);
  update();

  // try to load the datatype async if it wasn't ready yet
  const doc = handle.doc();
  if (doc) {
    const datatypeId = getType(doc);
    if (datatypeId) {
      const registry = getRegistry("patchwork:datatype");
      registry.load(datatypeId).then(() => update());
    }
  }

  element.appendChild(wrapper);

  return () => {
    handle.off("change", update);
    button.removeEventListener("click", onAddDocToSidebar);
  };
}
