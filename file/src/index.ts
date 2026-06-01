// File plugin for Patchwork — entry registers metadata only; implementations load on demand.

export type * from "./types";

export const plugins = [
	{
		type: "patchwork:datatype",
		id: "file",
		name: "File",
		icon: "File",
		unlisted: true,
		async load() {
			return (await import("./datatype")).FileDatatype;
		},
	},
	{
		type: "patchwork:tool",
		id: "file",
		name: "File",
		icon: "File",
		supportedDatatypes: ["file"],
		async load() {
			return (await import("./tool")).FileTool;
		},
	},
	{
		type: "patchwork:datatype",
		id: "new-file",
		name: "New File",
		icon: "FilePlus",
		async load() {
			return (await import("./new-file-datatype")).NewFileDatatype;
		},
	},
	{
		type: "patchwork:tool",
		id: "new-file",
		name: "New File",
		icon: "FilePlus",
		supportedDatatypes: ["new-file"],
		async load() {
			return (await import("./new-file-tool")).NewFileTool;
		},
	},
];
