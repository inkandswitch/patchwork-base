import type { Plugin, ToolElement } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-draft-list-provider",
    name: "Draft List Provider",
    async load() {
      const { DraftListProvider } =
        await import("./providers/DraftListProvider.js");
      return DraftListProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-draft-overlay-provider",
    name: "Draft Overlay Provider",
    async load() {
      const { DraftOverlayProvider } =
        await import("./providers/DraftOverlayProvider.js");
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
    unlisted: true,
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
  // A `patchwork:component` that takes no document: the render function
  // ignores its handle (it reads everything off `element`), so we pass `null`
  // and it can be slotted in without an account doc.
  {
    type: "patchwork:component",
    id: "drafts",
    name: "Drafts",
    tags: ["context-tool"],
    async load() {
      const { renderDraftsSidebar } = await import("./main");
      return (element: ToolElement) =>
        renderDraftsSidebar(null as never, element);
    },
  },
];

export type {
  Baseline,
  CheckedOutDraft,
  CloneEntry,
  DraftDoc,
  DraftList,
  DraftMemberDoc,
  DraftSummary,
} from "./draft-types.js";
export { isDraftDoc } from "./draft-types.js";
