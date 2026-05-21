import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:component",
    id: "patchwork-comments-provider",
    name: "Comments Provider",
    async load() {
      const { CommentsProvider } = await import("./CommentsProvider.js");
      return CommentsProvider;
    },
  },
];
