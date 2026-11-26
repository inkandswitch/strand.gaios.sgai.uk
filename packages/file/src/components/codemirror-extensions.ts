import type {Extension} from "@codemirror/state"
import type {FileDoc} from "../types"

// The event a tool embedding this one (in a <patchwork-view tool-id="file">)
// listens for to add its own CodeMirror extensions. The text editor
// dispatches it just before it creates its view, again whenever it's rebuilt,
// and it bubbles out of the patchwork-view; a listener pushes onto
// `detail.extensions`. Extensions have to come from the shared @codemirror/*
// modules in the import map, like the editor's. `readOnly` says whether the
// text can be typed into this time.
export const CODEMIRROR_EXTENSIONS_EVENT = "file:codemirror-extensions"

export type CodemirrorExtensionsDetail = {
	handle: any
	doc: FileDoc
	readOnly: boolean
	extensions: Extension[]
}

export function collectExtensions(
	element: HTMLElement | undefined,
	handle: any,
	doc: FileDoc,
	readOnly: boolean,
): Extension[] {
	if (!element) return []
	const detail: CodemirrorExtensionsDetail = {
		handle,
		doc,
		readOnly,
		extensions: [],
	}
	element.dispatchEvent(
		new CustomEvent(CODEMIRROR_EXTENSIONS_EVENT, {
			detail,
			bubbles: true,
			composed: true,
		}),
	)
	return detail.extensions
}
