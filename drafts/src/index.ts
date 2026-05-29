import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-draft-list-provider",
    name: "Draft List Provider",
    async load() {
      const { DraftListProvider } = await import(
        "./providers/DraftListProvider.js"
      );
      return DraftListProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-draft-overlay-provider",
    name: "Draft Overlay Provider",
    async load() {
      const { DraftOverlayProvider } = await import(
        "./providers/DraftOverlayProvider.js"
      );
      return DraftOverlayProvider;
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
