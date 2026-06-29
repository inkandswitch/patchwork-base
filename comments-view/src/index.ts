import { Plugin, ToolElement } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:tool",
    id: "comments-view",
    tags: ["context-tool"],
    name: "Comments",
    icon: "Comments",
    supportedDatatypes: ["account"],
    async load() {
      const { renderCommentsView } = await import("./main");
      return renderCommentsView;
    },
  },
  // Same view, but as a `patchwork:component` that takes no document: the
  // render function ignores its handle (it reads everything off `element`),
  // so we pass `null` and it can be slotted in without an account doc.
  {
    type: "patchwork:component",
    id: "comments-view",
    tags: ["context-tool"],
    name: "Comments",
    async load() {
      const { renderCommentsView } = await import("./main");
      return (element: ToolElement) => renderCommentsView(null as never, element);
    },
  },
];
