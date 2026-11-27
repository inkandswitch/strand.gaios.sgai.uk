import {createMemo, createSignal, onCleanup, Show, type Accessor} from "solid-js"
import {
	EditorView,
	lineNumbers,
	highlightSpecialChars,
	highlightActiveLineGutter,
	highlightActiveLine,
	rectangularSelection,
	keymap,
} from "@codemirror/view"
import {EditorState, Compartment} from "@codemirror/state"
import {
	indentUnit,
	bracketMatching,
	foldGutter,
	foldKeymap,
} from "@codemirror/language"
import {
	highlightSelectionMatches,
	searchKeymap,
} from "@codemirror/search"
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
	emacsStyleKeymap,
} from "@codemirror/commands"
import {automergeSyncPlugin} from "@automerge/automerge-codemirror"
import {fileText, isImmutableStringFileDoc} from "../datatype"
import {scrollPastEndWhenLong} from "./scroll-past-end"
import {collectExtensions} from "./codemirror-extensions"
import {createFileComments} from "./comments"
import {diffEditor, follow, useDraftCompare, type DraftCompare} from "./draft-diff"
import codemirrorTheme from "../codemirror-theme"
import {getLanguageExtension} from "../languages"
import type {FileDoc} from "../types"

enum mod {
	shift = 1,
	control = 2,
	option = 3,
	command = 4,
}

function modshift(event: {
	ctrlKey: boolean
	shiftKey: boolean
	altKey: boolean
	metaKey: boolean
}) {
	let bits = 0
	bits |= +event.shiftKey << mod.shift
	bits |= +event.ctrlKey << mod.control
	bits |= +event.altKey << mod.option
	bits |= +event.metaKey << mod.command
	return bits
}

// A file is treated as text whenever its content actually is text — a plain
// string (editable) or an ImmutableString (read-only). Text kept as bytes is
// shown read-only too (see `isTextBytesFileDoc`). We key off the content
// shape rather than the declared mimeType, which is frequently missing or
// generic (e.g. application/octet-stream) for files that are perfectly editable
// text.
export const isTextFile = (doc: FileDoc) => {
	return typeof doc?.content === "string" || (!!doc && isImmutableStringFileDoc(doc))
}

// Code files get TypeScript's language server (completions, hovers,
// diagnostics), under the language id it knows each extension by.
const LSP_LANGUAGES: Record<string, string> = {
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascriptreact",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescriptreact",
}

const lspLanguage = (extension?: string): string | undefined => {
	if (!extension) return undefined
	const ext = extension.startsWith(".") ? extension.slice(1) : extension
	return LSP_LANGUAGES[ext.toLowerCase()]
}

type EditorProps = {
	doc: FileDoc
	handle: any
	element?: HTMLElement
}

// Whether `handle` takes writes. A handle the overlay provider hands out is
// re-pointed in place: checked out at a point in history it turns read-only,
// and back again on the working copy.
const takesWrites = (handle: any) => !!handle && !handle.isReadOnly?.()

/**
 * Any text file: typed into when it's plain text read through a handle that
 * takes writes, read-only otherwise (an ImmutableString, text kept as bytes,
 * or a handle at a point in history), following the file as it changes.
 * Which it is is read off the handle and the content, and the editor is
 * rebuilt when that changes, as it is going in or out of side by side, where
 * the other version is laid out beside it.
 */
export function TextFileEditor(props: EditorProps) {
	const compare =
		props.handle && props.element ? useDraftCompare(props.element, props.handle) : () => undefined
	const beside = createMemo(() => compare()?.mode === "side-by-side")

	// Asked again whenever the handle changes, which a re-point is. After the
	// change has gone round its listeners, the editor's own among them.
	const [handleWrites, setHandleWrites] = createSignal(takesWrites(props.handle))
	if (props.handle) {
		let live = true
		const check = () =>
			queueMicrotask(() => {
				if (live) setHandleWrites(takesWrites(props.handle))
			})
		props.handle.on("change", check)
		onCleanup(() => {
			live = false
			props.handle.off("change", check)
		})
	}
	const writable = createMemo(() => handleWrites() && typeof props.doc.content === "string")

	const shape = createMemo(
		() => ({beside: beside(), writable: writable()}),
		undefined,
		{equals: (a, b) => a?.beside === b.beside && a?.writable === b.writable},
	)
	return (
		<Show when={shape()} keyed>
			{(current) => (
				<Editor
					doc={props.doc}
					handle={props.handle}
					element={props.element}
					compare={compare}
					beside={current.beside}
					writable={current.writable}
				/>
			)}
		</Show>
	)
}

function Editor(
	props: EditorProps & {
		compare: Accessor<DraftCompare | undefined>
		beside: boolean
		writable: boolean
	},
) {
	const languageExtension = getLanguageExtension(
		props.doc.extension,
		props.doc.mimeType,
	)

	// The language server's features are reconfigured into this compartment
	// once its client has loaded — see below.
	const tsCompartment = new Compartment()

	const comments =
		props.handle && props.element
			? createFileComments({handle: props.handle, element: props.element})
			: undefined

	// Typing: written through to the file as it's typed, and the file's own
	// changes merged back in.
	const editing = (handle: any) => [
		history(),
		indentUnit.of("\t"),
		EditorState.allowMultipleSelections.of(true),
		EditorView.clickAddsSelectionRange.of((event) => {
			const mask = modshift(event)
			if (mask == 1 << mod.option) return true
			return false
		}),
		rectangularSelection({
			eventFilter(event) {
				const mask = modshift(event)
				if (mask == ((1 << mod.shift) | (1 << mod.option)))
					return true
				return false
			},
		}),
		keymap.of([
			indentWithTab,
			...emacsStyleKeymap,
			...searchKeymap,
			...historyKeymap,
			...foldKeymap,
			...defaultKeymap,
		]),
		tsCompartment.of([]),
		automergeSyncPlugin({handle, path: ["content"]}),
	]
	// Read-only: nothing typed, and the file followed below.
	const reading = () => [
		EditorState.readOnly.of(true),
		EditorView.editable.of(false),
		keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
	]

	const editor = diffEditor({
		doc: fileText(props.handle?.doc() ?? props.doc),
		compare: props.compare,
		beside: props.beside,
		besideExtensions: [
			lineNumbers(),
			highlightSpecialChars(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			history(),
			bracketMatching(),
			indentUnit.of("\t"),
			EditorState.allowMultipleSelections.of(true),
			EditorState.tabSize.of(2),
			EditorView.lineWrapping,
			keymap.of([
				indentWithTab,
				...emacsStyleKeymap,
				...searchKeymap,
				...historyKeymap,
				...defaultKeymap,
			]),
			languageExtension,
			...codemirrorTheme,
		],
		extensions: [
			lineNumbers(),
			highlightSpecialChars(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			foldGutter(),
			bracketMatching(),
			EditorState.tabSize.of(2),
			EditorView.lineWrapping,
			scrollPastEndWhenLong(),
			props.writable ? editing(props.handle) : reading(),
			languageExtension,
			...codemirrorTheme,
			comments?.extension ?? [],
			// last, so they can override anything above
			collectExtensions(props.element, props.handle, props.doc, !props.writable),
		],
	})
	const view = editor.view
	comments?.attach(view)

	// Read-only, the file is followed as it changes: an ImmutableString is
	// replaced whole, and a point in history moves in place.
	if (!props.writable && props.handle) {
		const read = () => follow(view, fileText(props.handle.doc()))
		props.handle.on("change", read)
		onCleanup(() => props.handle.off("change", read))
	}

	// For code files, connect to the shared TypeScript language server (tsgo,
	// in a worker) and add its features to the editor in place. Each document
	// is its own folder in the server's filesystem, so open files never clash.
	// It's loaded on demand, so only code files pay for it.
	const languageId = props.writable ? lspLanguage(props.doc.extension) : undefined
	if (languageId) {
		let disposed = false
		onCleanup(() => {
			disposed = true
		})
		const ext = props.doc.extension.replace(/^\./, "").toLowerCase()
		const uri = `file:///${props.handle?.documentId ?? "untitled"}/index.${ext}`
		void import("../typescript-language-server")
			.then(({typescriptLanguageServer}) => {
				if (disposed) return
				view.dispatch({
					effects: tsCompartment.reconfigure(
						typescriptLanguageServer().plugin(uri, languageId),
					),
				})
			})
			.catch((error) => {
				// type hints are an extra: without them it's a plain editor
				console.error("failed to start TypeScript language server", error)
			})
	}

	onCleanup(() => {
		editor.destroy()
	})

	// cmd+= / cmd+- / cmd+0 (ctrl off a Mac) resize the editor's text instead
	// of zooming the whole page.
	const MIN_FONT_SIZE = 6
	const apple = ["Mac", "iPhone", "iPad"].some((name) =>
		navigator.platform.includes(name),
	)
	const zoomMask = 1 << (apple ? mod.command : mod.control)
	const zoom = (event: KeyboardEvent) => {
		if ((modshift(event) & ~(1 << mod.shift)) != zoomMask) return
		let step
		if (event.key == "=" || event.key == "+") step = 1
		else if (event.key == "-" || event.key == "_") step = -1
		else if (event.key == "0") step = 0
		else return
		event.preventDefault()
		event.stopPropagation()
		const size = parseFloat(getComputedStyle(view.dom).fontSize)
		for (const each of editor.views) {
			each.dom.style.fontSize =
				step == 0 ? "" : `${Math.max(MIN_FONT_SIZE, size + step)}px`
			each.requestMeasure()
		}
	}

	return (
		<div
			onKeyDown={zoom}
			ref={(el) => {
				el.appendChild(editor.dom)
			}}
			style={{
				width: "100%",
				height: "100%",
			}}
		/>
	)
}
