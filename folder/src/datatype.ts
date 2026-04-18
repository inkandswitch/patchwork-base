import { DatatypeImplementation } from '@inkandswitch/patchwork-plugins';
import type {
  FolderDoc,
  UnixFileEntry,
} from '@inkandswitch/patchwork-filesystem';

export const FolderDatatype: DatatypeImplementation<FolderDoc> = {
  init(doc) {
    doc.title = '';
    doc.docs = [];
  },
  getTitle: (doc) => doc.title || 'Untitled Folder',
  setTitle: (doc, title) => {
    doc.title = title;
  },
};

export type FileDoc = UnixFileEntry;

export const FileDatatype: DatatypeImplementation<FileDoc> = {
  init: (doc: FileDoc) => {
    throw new Error("Can't create empty ");
  },
  getTitle(doc: FileDoc) {
    return doc.name || 'Untitled File';
  },
  setTitle(doc: FileDoc, title: string) {
    doc.name = title;
  },
};
