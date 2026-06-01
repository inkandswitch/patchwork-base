import type { Plugin } from "@inkandswitch/patchwork-plugins";

export const plugins: Plugin<any>[] = [
  {
    type: "patchwork:tool",
    id: "frame-configurator",
    name: "Frame Configurator",
    icon: "Settings",
    supportedDatatypes: ["account"],
    async load() {
      const { renderFrameConfigurator } = await import("./FrameConfigurator");
      return renderFrameConfigurator;
    },
  },
];
