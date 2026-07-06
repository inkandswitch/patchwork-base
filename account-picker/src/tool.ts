export const plugins = [
  {
    type: "patchwork:tool",
    id: "account-picker",
    name: "Account Picker",
    supportedDatatypes: ["account"],
    async load() {
      const { loadTool } = await import("./AccountPicker.tsx");
      return loadTool();
    },
  },
];
