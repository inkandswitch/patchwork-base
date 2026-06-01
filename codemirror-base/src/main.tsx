import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { TextDoc } from "./tool.tsx";

export const plugins = [
  {
    type: "patchwork:tool",
    id: "codemirror-base",
    name: "Text Editor",
    supportedDatatypes: ["essay", "markdown"],
    async load(): Promise<ToolImplementation<TextDoc>> {
      const { renderCodeMirrorBase } = await import("./tool.tsx");
      return renderCodeMirrorBase;
    },
  },
];
