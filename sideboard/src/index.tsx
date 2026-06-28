import "./index.css";
import { render } from "solid-js/web";
import { type ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import type { SideboardAccountDoc } from "./types.ts";

async function loadStyles() {
  const url = new URL("./index.css", import.meta.url);
  return (await fetch(url)).text();
}

function addStyles(textContent: string) {
  const id = "sideboard-styles";
  const el =
    document.head.querySelector(`#${id}`) ?? document.createElement("style");
  Object.assign(el, { textContent, id });
  document.head.append(el);
}

export const plugins = [
  {
    id: "chee/document-list",
    type: "patchwork:tool",
    name: "Document List",
    supportedDatatypes: ["folder"],
    icon: "FolderOpen",
    unlisted: true,
    async load(): Promise<ToolImplementation<FolderDoc>> {
      const [{ DocumentListPanel }, styles] = await Promise.all([
        import("./sideboard/document-list-panel.tsx"),
        loadStyles(),
      ]);
      return (handle, element) => {
        addStyles(styles);
        return render(
          () => (
            <DocumentListPanel
              folderUrl={handle.url}
              repo={element.repo}
              element={element}
            />
          ),
          element
        );
      };
    },
  },
  {
    id: "chee/account-bar",
    type: "patchwork:tool",
    name: "Account Bar",
    supportedDatatypes: ["account"],
    icon: "UserCircle",
    unlisted: true,
    async load(): Promise<ToolImplementation<SideboardAccountDoc>> {
      const [{ AccountBar }, styles] = await Promise.all([
        import("./sideboard/account-bar.tsx"),
        loadStyles(),
      ]);
      return (handle, element) => {
        addStyles(styles);
        return render(
          () => (
            <AccountBar handle={handle} repo={element.repo} element={element} />
          ),
          element
        );
      };
    },
  },
  {
    id: "chee/sideboard",
    type: "patchwork:tool",
    tags: ["sidebar-account"],
    name: "Sideboard",
    supportedDatatypes: ["account"],
    icon: "FolderOpen",
    unlisted: true,
    async load(): Promise<ToolImplementation<SideboardAccountDoc>> {
      const [{ Sideboard }, styles] = await Promise.all([
        import("./sideboard/sideboard.tsx"),
        loadStyles(),
      ]);
      return (handle, element) => {
        addStyles(styles);
        return render(
          () => (
            <Sideboard handle={handle} repo={element.repo} element={element} />
          ),
          element
        );
      };
    },
  },
];
