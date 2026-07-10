// Entry module — read by the module-settings worker just to enumerate plugins.
// That worker has no importmap, so this file must contain NO static imports of
// bare/external specifiers (solid-js, patchwork-plugins, …) and no top-level
// functions on a plugin except `load`. Everything real lives behind load()'s
// dynamic import, which runs on the main thread where the importmap exists.

export const plugins = [
  {
    type: "patchwork:tool",
    id: "packages",
    name: "Packages",
    icon: "Package",
    // The tool takes a module-settings doc as its handle (it reads doc.modules
    // to tell "installed" from "core"/"ephemeral"), but what it *renders* is the
    // live registry.
    supportedDatatypes: ["patchwork:module-settings"],
    async load() {
      const { mount } = await import("./mount.tsx");
      return mount;
    },
  },
];
