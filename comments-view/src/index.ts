import { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:tool",
    id: "comments-view-2",
    tags: ["context-tool"],
    name: "Comments 2",
    icon: "Comments",
    supportedDatatypes: ["account"],
    async load() {
      const { renderCommentsView } = await import("./CommentsView");
      return renderCommentsView;
    },
  },
];
