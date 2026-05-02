import { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:tool",
    id: "context-view",
    tags: ["context-tool"],
    name: "Context",
    icon: "TextSearch",
    supportedDatatypes: ["context-view"],
    async load() {
      const { renderContextView } = await import("./ContextView");
      return renderContextView;
    },
  },
];
