import { Plugin, ToolImplementation } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc } from "./types";

async function loadFrame(
  isolation?: boolean
): Promise<ToolImplementation<AccountDoc>> {
  const { renderPatchworkFrame } = await import("./PatchworkFrame");
  return renderPatchworkFrame(isolation);
}

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
    type: "patchwork:datatype",
    id: "threepane:config",
    name: "Threepane Config",
    icon: "Settings",
    unlisted: true,
    async load() {
      const { ThreepaneConfigDatatype } = await import("./datatypes");
      return ThreepaneConfigDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "threepane",
    tags: ["frame-tool"],
    name: "Threepane",
    icon: "Window",
    supportedDatatypes: ["account"],
    load: loadFrame,
  },
  {
    type: "patchwork:tool",
    id: "threepane-isolation",
    tags: ["frame-tool"],
    name: "Threepane (isolation mode)",
    icon: "Window",
    supportedDatatypes: ["account"],
    load: () => loadFrame(true),
  },
  {
    // The isolated document-area root mounted inside the iframe by `threepane-isolation`.
    type: "patchwork:component",
    id: "threepane-isolation-root",
    name: "Threepane Isolation Root",
    async load() {
      const { mountIsolationRoot } =
        await import("./components/IsolatedDocumentArea");
      return mountIsolationRoot;
    },
  },
  {
    // Back-compat alias: accounts whose frameToolId still points at the old id
    // keep resolving. Unlisted + untagged so it isn't offered as a new option.
    type: "patchwork:tool",
    id: "patchwork-frame",
    name: "Patchwork Frame",
    icon: "Window",
    supportedDatatypes: ["account"],
    unlisted: true,
    load: loadFrame,
  },
];
