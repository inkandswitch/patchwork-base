export const FolderDatatype = {
  init(doc) {
    doc.title = "";
    doc.docs = [];
  },
  getTitle: (doc) => doc.title || "Untitled Folder",
  setTitle: (doc, title) => {
    doc.title = title;
  },
};

export const FileDatatype = {
  init: () => {
    throw new Error("Can't create empty ");
  },
  getTitle(doc) {
    return doc.name || "Untitled File";
  },
  setTitle(doc, title) {
    doc.name = title;
  },
};
