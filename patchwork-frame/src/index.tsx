import type { Plugin, ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc } from "./types";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:datatype",
    id: "account",
    name: "Patchwork Account",
    icon: "UserCircle",
    unlisted: true,
    async load() {
      const { AccountDatatype } = await import("./datatypes");
      return AccountDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "patchwork-frame",
    tags: ["frame-tool"],
    name: "Patchwork Frame",
    icon: "Window",
    supportedDatatypes: ["account"],
    async load(): Promise<ToolImplementation<AccountDoc>> {
      const { renderPatchworkFrame } = await import("./PatchworkFrame");
      return renderPatchworkFrame;
    },
  },
];
