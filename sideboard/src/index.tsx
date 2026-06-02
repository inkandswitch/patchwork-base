import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { TinyPatchworkAccountDoc } from "./types.ts";

export const plugins = [
  {
    id: "chee/sideboard",
    type: "patchwork:tool",
    tags: ["sidebar-account"],
    name: "Sideboard",
    supportedDatatypes: ["patchwork:account", "folder"],
    icon: "FolderOpen",
    unlisted: true,
    async load(): Promise<ToolImplementation<TinyPatchworkAccountDoc>> {
      const { renderSideboard } = await import("./sideboard/sideboard.tsx");
      return renderSideboard;
    },
  },
];
