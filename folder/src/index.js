export const plugins = [
  {
    type: "patchwork:datatype",
    id: "folder",
    name: "Folder",
    icon: "Folder",
    unlisted: true,
    async load() {
      const { FolderDatatype } = await import("./datatype.js");
      return FolderDatatype;
    },
  },
  {
    type: "patchwork:tool",
    id: "folder-viewer",
    name: "Folder Viewer",
    supportedDatatypes: ["folder"],
    async load() {
      const { FolderTool } = await import("./tool.js");
      return FolderTool;
    },
  },
  {
    type: "patchwork:datatype",
    id: "file",
    name: "File",
    icon: "File",
    unlisted: true,
    async load() {
      const { FileDatatype } = await import("./datatype.js");
      return FileDatatype;
    },
  },
];
