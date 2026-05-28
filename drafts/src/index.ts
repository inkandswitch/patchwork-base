import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-draft-root-provider",
    name: "Draft Root Provider",
    async load() {
      const { DraftRootProvider } = await import(
        "./providers/DraftRootProvider.js"
      );
      return DraftRootProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-draft-provider",
    name: "Draft Provider",
    async load() {
      const { DraftProvider } = await import("./providers/DraftProvider.js");
      return DraftProvider;
    },
  },
  {
    type: "patchwork:datatype",
    id: "patchwork:draft",
    name: "Draft",
    async load() {
      const { DraftDatatype } = await import("./DraftDatatype.js");
      return DraftDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "drafts",
    tags: ["context-tool"],
    name: "Drafts",
    icon: "GitBranch",
    supportedDatatypes: ["account"],
    async load() {
      const { renderDraftsSidebar } = await import("./main");
      return renderDraftsSidebar;
    },
  },
];

export type { CloneEntry, DraftDoc, DraftsState } from "./draft-types.js";
export { isDraftDoc } from "./draft-types.js";
