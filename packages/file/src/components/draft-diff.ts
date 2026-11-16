// What differs from the other draft's version of a text file, which the
// panel showing it compares it with: marked inline, or with that version
// read-only beside the editor, lined up and scrolling with it. Unchanged
// stretches fold away while the panel says to collapse them. Only shows
// inside something answering `compare:view`, like the GAIOS dock while the
// checked-out draft is compared with another.

import {createEffect, createMemo, on, untrack, type Accessor} from "solid-js"
import {Automerge} from "@automerge/automerge-repo/slim"
import {Compartment, EditorState, type Extension} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {MergeView, unifiedMergeView} from "@codemirror/merge"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"

// The compare view the dock answers with, as this reads it.
type CompareView = {
	mode: string | null
	options: unknown
	other: Uint8Array | null
	missing: boolean
	collapsed?: boolean
}

/**
 * The text to show changes against, how, and whether to fold what didn't
 * change. Empty text when the other draft doesn't have the file.
 */
export type DraftCompare = {
	mode: "inline" | "side-by-side"
	original: string
	collapsed: boolean
}

const MODES = ["inline", "side-by-side"] as const

const COLLAPSE = {margin: 3, minSize: 4}

/** Undefined unless the file is compared in a mode the editor draws. */
export function useDraftCompare(element: HTMLElement): Accessor<DraftCompare | undefined> {
	const compare = subscribe(element, {
		type: "compare:view",
		modes: {inline: true, "side-by-side": true},
		draws: ["side-by-side"],
		collapses: [...MODES],
		prefers: "inline",
	})
	return createMemo<DraftCompare | undefined>(
		() => {
			const view = compare() as unknown as CompareView | undefined
			const mode = MODES.find(each => each === view?.mode)
			if (!view || !mode) return undefined
			const collapsed = !!view.collapsed
			if (view.missing) return {mode, original: "", collapsed}
			if (!view.other) return undefined
			try {
				return {mode, original: fileText(Automerge.load<FileDoc>(view.other)), collapsed}
			} catch (error) {
				console.warn("[file] couldn't read the version compared with", error)
				return undefined
			}
		},
		undefined,
		{
			equals: (a, b) =>
				a?.mode === b?.mode && a?.original === b?.original && a?.collapsed === b?.collapsed,
		},
	)
}

/**
 * The editor for `doc`: on its own, with what differs marked inline while
 * the compare is inline, or beside the other version while it's side by
 * side, which it's built for (see `useDraftCompare`).
 */
export function diffEditor(config: {
	doc: string
	extensions: Extension[]
	/** for the other version, read-only beside it */
	besideExtensions: Extension[]
	compare: Accessor<DraftCompare | undefined>
	beside: boolean
}): {view: EditorView; dom: HTMLElement; views: EditorView[]; destroy(): void} {
	if (config.beside) return besideDiff(config)
	const inline = new Compartment()
	const view = new EditorView({
		doc: config.doc,
		extensions: [config.extensions, inline.of([])],
	})
	followInline(view, inline, config.compare)
	return {view, dom: view.dom, views: [view], destroy: () => view.destroy()}
}

function followInline(
	view: EditorView,
	compartment: Compartment,
	compare: Accessor<DraftCompare | undefined>,
) {
	const inline = createMemo(() => {
		const current = compare()
		return current?.mode === "inline" ? current : undefined
	})
	createEffect(
		on(inline, (current, previous) => {
			view.dispatch({
				effects: compartment.reconfigure(
					current === undefined
						? []
						: [
								unifiedMergeView({
									original: current.original,
									mergeControls: false,
									syntaxHighlightDeletions: true,
									collapseUnchanged: current.collapsed ? COLLAPSE : undefined,
								}),
								DIFF_COLOURS,
							],
				),
			})
			// Starting to compare, or folding what's unchanged away or back,
			// the file shows from its very top.
			if (current === undefined) return
			if (previous !== undefined && previous.collapsed === current.collapsed) return
			view.dispatch({effects: EditorView.scrollIntoView(0, {y: "start"})})
			view.scrollDOM.scrollTop = 0
		}),
	)
}

// The editor goes first, as B, and the other version after it, as A: what's
// only in B is what was inserted, what's only in A what was deleted.
function besideDiff(config: {
	doc: string
	extensions: Extension[]
	besideExtensions: Extension[]
	compare: Accessor<DraftCompare | undefined>
}) {
	const initial = untrack(config.compare)
	const merge = new MergeView({
		a: {
			doc: initial?.original ?? "",
			extensions: [
				EditorState.readOnly.of(true),
				EditorView.editable.of(false),
				config.besideExtensions,
				DIFF_COLOURS,
			],
		},
		b: {doc: config.doc, extensions: [config.extensions, DIFF_COLOURS]},
		orientation: "b-a",
		gutter: true,
		collapseUnchanged: initial?.collapsed ? COLLAPSE : undefined,
	})
	Object.assign(merge.dom.style, {height: "100%", overflow: "auto"})

	createEffect(
		on(
			() => config.compare()?.original,
			text => {
				const other = merge.a
				if (text === undefined || text === other.state.doc.toString()) return
				other.dispatch({changes: {from: 0, to: other.state.doc.length, insert: text}})
			},
			{defer: true},
		),
	)
	createEffect(
		on(
			() => !!config.compare()?.collapsed,
			collapsed => {
				merge.reconfigure({collapseUnchanged: collapsed ? COLLAPSE : undefined})
				merge.dom.scrollTop = 0
			},
			{defer: true},
		),
	)
	return {
		view: merge.b,
		dom: merge.dom,
		views: [merge.b, merge.a],
		destroy: () => merge.destroy(),
	}
}

// What's only in this version and only in the other, in the colours the
// panel showing it gives them. Beside the other version, that's the whole
// of each side.
const INSERTED = "var(--compare-inserted, #22bb22)"
const DELETED = "var(--compare-deleted, #ee4433)"
const tint = (colour: string, amount: number) =>
	`color-mix(in srgb, ${colour} ${amount}%, transparent)`
const underline = (colour: string) =>
	`linear-gradient(${tint(colour, 60)}, ${tint(colour, 60)}) bottom/100% 2px no-repeat !important`

const DIFF_COLOURS = EditorView.theme({
	".cm-changedLine, .cm-inlineChangedLine": {
		backgroundColor: `${tint(INSERTED, 10)} !important`,
	},
	"&.cm-merge-a .cm-changedLine": {backgroundColor: `${tint(DELETED, 9)} !important`},
	".cm-changedText": {background: underline(INSERTED)},
	"&.cm-merge-a .cm-changedText": {background: underline(DELETED)},
	".cm-deletedChunk": {backgroundColor: `${tint(DELETED, 9)} !important`},
	".cm-deletedChunk .cm-deletedText": {background: underline(DELETED)},
	".cm-changedLineGutter": {background: `${INSERTED} !important`},
	"&.cm-merge-a .cm-changedLineGutter": {background: `${DELETED} !important`},
	".cm-deletedLineGutter": {background: `${DELETED} !important`},
})
