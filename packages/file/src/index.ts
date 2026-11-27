// File plugin for Patchwork
// Bundleless plugin that supports viewing and editing various file types

import {FileDatatype} from "./datatype"
import {NewFileDatatype} from "./new-file-datatype"

export * from "./types"
export * from "./datatype"
export * from "./utils"
export {replaceFileContent} from "./components/comments/anchors"

export const plugins = [
	{
		type: "patchwork:datatype",
		id: "file",
		name: "File",
		icon: "File",
		unlisted: true,
		async load() {
			return FileDatatype
		},
	},
	{
		type: "patchwork:tool",
		id: "file",
		name: "File",
		icon: "File",
		supportedDatatypes: ["file"],
		async load() {
			return (await import("./tool")).FileTool
		},
	},
	{
		// What a comment on a file is about, drawn in the comments sidebar: an
		// image pin or region, or a quote of the commented text.
		type: "patchwork:ref-view",
		id: "file-ref",
		name: "File ref",
		supportedDatatypes: ["file"],
		async load() {
			return (await import("./ref-view")).default
		},
	},
	{
		// Where a merge of a text file needs a person: lines both sides changed.
		type: "patchwork:merge-conflicts",
		id: "file-text-conflicts",
		name: "Text conflicts",
		datatypes: ["file"],
		async load() {
			return (await import("./conflicts")).findTextConflicts
		},
	},
	{
		type: "patchwork:datatype",
		id: "new-file",
		name: "New File",
		icon: "FilePlus",
		async load() {
			return NewFileDatatype
		},
	},
	{
		type: "patchwork:tool",
		id: "new-file",
		name: "New File",
		icon: "FilePlus",
		supportedDatatypes: ["new-file"],
		async load() {
			return (await import("./new-file-tool")).NewFileTool
		},
	},
]
