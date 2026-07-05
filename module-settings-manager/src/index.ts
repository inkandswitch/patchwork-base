export const plugins = [
  {
    type: "patchwork:datatype",
    id: "patchwork:module-settings",
    name: "Module Settings",
    icon: "Settings",
    unlisted: true,
    async load() {
      const { ModuleSettingsDatatype } = await import("./datatype.ts");
      return ModuleSettingsDatatype;
    },
  },
  {
    id: "module-settings-manager",
    type: "patchwork:tool",
    name: "Module Settings Manager",
    icon: "Settings",
    supportedDatatypes: ["patchwork:module-settings", "my-tools"],
    async load() {
      const { loadTool } = await import("./mount.tsx");
      return loadTool();
    },
  },
];
