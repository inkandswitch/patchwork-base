import { Plugin, ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { render } from "solid-js/web";
import type { AccountDoc } from "./types";

async function loadFrame(): Promise<ToolImplementation<AccountDoc>> {
  const { PatchworkFrame } = await import("./PatchworkFrame");
  return (handle, element) => {
    return render(
      () => <PatchworkFrame handle={handle} repo={element.repo} />,
      element
    );
  };
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
