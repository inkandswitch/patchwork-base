/** @jsxImportSource solid-js */
import { render } from "solid-js/web";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { HistoryDoc } from "./types.ts";

const STYLE_ID = "account-history-styles";

async function loadStyles() {
  const url = new URL("./index.css", import.meta.url);
  return (await fetch(url)).text();
}

function addStyles(textContent: string) {
  if (document.head.querySelector(`#${STYLE_ID}`)) return;
  const el = document.createElement("style");
  Object.assign(el, { textContent, id: STYLE_ID });
  document.head.append(el);
}

export async function renderHistoryRecorder(): Promise<ToolImplementation<any>> {
  const { HistoryRecorder } = await import("./HistoryRecorder.tsx");
  return (handle, element) => {
    return render(
      () => (
        <HistoryRecorder
          handle={handle}
          repo={element.repo}
          element={element}
        />
      ),
      element
    );
  };
}

export async function renderHistoryViewer(): Promise<
  ToolImplementation<HistoryDoc>
> {
  const [{ HistoryViewer }, styles] = await Promise.all([
    import("./HistoryViewer.tsx"),
    loadStyles(),
  ]);
  addStyles(styles);
  return (handle, element) => {
    return render(
      () => (
        <HistoryViewer
          handle={handle}
          repo={element.repo}
          element={element}
        />
      ),
      element
    );
  };
}

export async function renderNotebookViewer(): Promise<
  ToolImplementation<HistoryDoc>
> {
  const [{ NotebookViewer }, styles] = await Promise.all([
    import("./NotebookViewer.tsx"),
    loadStyles(),
  ]);
  addStyles(styles);
  return (handle, element) => {
    return render(
      () => (
        <NotebookViewer
          handle={handle}
          repo={element.repo}
          element={element}
        />
      ),
      element
    );
  };
}
