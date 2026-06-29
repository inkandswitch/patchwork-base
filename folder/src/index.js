export const plugins = [
  {
    type: 'patchwork:datatype',
    id: 'folder',
    name: 'Folder',
    icon: 'Folder',
    async load() {
      const { FolderDatatype } = await import('./datatype.js');
      return FolderDatatype;
    },
  },
  {
    type: 'patchwork:tool',
    id: 'folder-viewer',
    name: 'Folder Viewer',
    supportedDatatypes: ['folder'],
    async load() {
      const { FolderTool } = await import('./tool.js');
      return FolderTool;
    },
  }
];
