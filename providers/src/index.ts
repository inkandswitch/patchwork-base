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
  {
    type: "patchwork:component",
    id: "patchwork-focus-provider",
    name: "Focus Provider",
    async load() {
      const { FocusProvider } = await import("./FocusProvider.js");
      return FocusProvider;
    },
  },
  {
    type: "patchwork:component",
    id: "patchwork-account-provider",
    name: "Account Provider",
    async load() {
      const { AccountProvider } = await import("./AccountProvider.js");
      return AccountProvider;
    },
  },
];
