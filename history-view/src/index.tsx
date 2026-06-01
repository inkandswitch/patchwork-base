import type { Plugin, ToolImplementation } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:datatype",
    id: "patchwork:history-change-groups",
    name: "Document History Change Groups",
    icon: "History",
    unlisted: true,
    async load() {
      return (await import("./history-groupings-datatype"))
        .HistoryGroupingsDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "history-view",
    name: "History",
    icon: "History",
    supportedDatatypes: ["account"],
    async load(): Promise<ToolImplementation<any>> {
      const { renderHistoryView } = await import("./history/HistoryTimeline");
      return renderHistoryView;
    },
  },
];
