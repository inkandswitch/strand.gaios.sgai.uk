// What differs from the other draft's version of a text file, which the
// panel showing it compares it with: marked inline, read-only, or with that
// version beside the editor, lined up and scrolling with it, and editable
// too while the panel says it can be changed. Unchanged stretches fold away
// while the panel says to collapse them. Only shows inside something
// answering `compare:view`, like the GAIOS dock while the checked-out draft
// is compared with another.

import {createEffect, createMemo, on, untrack, type Accessor} from "solid-js"
import {Automerge} from "@automerge/automerge-repo/slim"
import {
	Annotation,
	Compartment,
	EditorState,
	RangeSetBuilder,
	StateField,
	Transaction,
	type ChangeSet,
	type Extension,
	type RangeSet,
} from "@codemirror/state"
import {Decoration, EditorView, GutterMarker, gutterLineClass, type DecorationSet} from "@codemirror/view"
import {getChunks, MergeView, unifiedMergeView, type Chunk} from "@codemirror/merge"
import {request} from "@inkandswitch/patchwork-providers"
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
	editable?: boolean
	names?: Names | null
	merging?: boolean
}

/** The two drafts' names: the checked-out one's, and the other's. */
type Names = {ours: string; theirs: string}

/**
 * The text to show changes against, how, whether to fold what didn't
 * change, and whether that text can be changed. Empty text when the other
 * draft doesn't have the file.
 */
export type DraftCompare = {
	mode: "inline" | "side-by-side"
	original: string
	collapsed: boolean
	editable: boolean
	/** to head each side with, side by side */
	names: Names | null
	/** this side shows the file after a merge, the other the target before it */
	merging: boolean
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
			const names = view.names ?? null
			const merging = !!view.merging
			if (view.missing) return {mode, original: "", collapsed, editable: false, names, merging}
			if (!view.other) return undefined
			const editable = !!view.editable
			try {
				return {
					mode,
					original: fileText(Automerge.load<FileDoc>(view.other)),
					collapsed,
					editable,
					names,
					merging,
				}
			} catch (error) {
				console.warn("[file] couldn't read the version compared with", error)
				return undefined
			}
		},
		undefined,
		{
			equals: (a, b) =>
				a?.mode === b?.mode &&
				a?.original === b?.original &&
				a?.collapsed === b?.collapsed &&
				a?.editable === b?.editable &&
				a?.names?.ours === b?.names?.ours &&
				a?.names?.theirs === b?.names?.theirs &&
				a?.merging === b?.merging,
		},
	)
}

/**
 * The editor for `doc`: on its own, with what differs marked inline, and
 * nothing typed into it, while the compare is inline, or beside the other
 * version while it's side by side, which it's built for (see
 * `useDraftCompare`).
 */
export function diffEditor(config: {
	doc: string
	extensions: Extension[]
	/** for the other version beside it */
	besideExtensions: Extension[]
	compare: Accessor<DraftCompare | undefined>
	beside: boolean
	/**
	 * Where to ask for the other version to be changed from, whenever it can
	 * be. It's only read without.
	 */
	editsFrom?: HTMLElement
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
								DRAFT_COLOURS,
								LOCKED,
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
// only in B is what was inserted, what's only in A what was deleted. What's
// typed into A goes to the other draft, while it can.
function besideDiff(config: {
	doc: string
	extensions: Extension[]
	besideExtensions: Extension[]
	compare: Accessor<DraftCompare | undefined>
	editsFrom?: HTMLElement
}) {
	const initial = untrack(config.compare)
	const writable = (current: DraftCompare | undefined) =>
		!!config.editsFrom && !!current?.editable
	const lock = new Compartment()
	const theirs = config.editsFrom ? sendEdits(config.editsFrom) : undefined
	const merge = new MergeView({
		a: {
			doc: initial?.original ?? "",
			extensions: [
				lock.of(writable(initial) ? [] : LOCKED),
				config.besideExtensions,
				DIFF_COLOURS,
				CHANGED_ON_BOTH,
				theirs?.extension ?? [],
			],
		},
		b: {doc: config.doc, extensions: [config.extensions, DIFF_COLOURS, CHANGED_ON_BOTH]},
		orientation: "b-a",
		gutter: true,
		collapseUnchanged: initial?.collapsed ? COLLAPSE : undefined,
	})
	Object.assign(merge.dom.style, {flex: "1", minHeight: "0", overflow: "auto"})

	// Each side headed by its draft's dot and name, above where it scrolls.
	const frame = document.createElement("div")
	Object.assign(frame.style, {display: "flex", flexDirection: "column", height: "100%"})
	const headings = document.createElement("div")
	Object.assign(headings.style, {display: "flex", flex: "none"})
	const ours = heading()
	const other = heading()
	other.element.style.borderLeft = EDGE
	headings.append(ours.element, other.element)
	frame.append(headings, merge.dom)
	createEffect(() => {
		const current = config.compare()
		const names = current?.names
		headings.hidden = !names
		if (!names) return
		ours.show(current.merging ? "Merged" : names.ours, OURS)
		other.show(names.theirs, THEIRS)
	})

	createEffect(
		on(
			() => config.compare()?.original,
			text => {
				if (text === undefined) return
				if (theirs) theirs.receive(merge.a, text)
				else follow(merge.a, text)
			},
			{defer: true},
		),
	)
	createEffect(
		on(
			() => writable(config.compare()),
			editable => merge.a.dispatch({effects: lock.reconfigure(editable ? [] : LOCKED)}),
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
		dom: frame,
		views: [merge.b, merge.a],
		destroy: () => merge.destroy(),
	}
}

const EDGE = "1px solid var(--compare-edge, rgb(0 0 0 / 0.08))"

// A side's heading: its draft's colour dot and name.
function heading() {
	const element = document.createElement("div")
	Object.assign(element.style, {
		flex: "1 1 0",
		minWidth: "0",
		display: "flex",
		alignItems: "center",
		gap: "0.3em",
		padding: "0.35rem 0.75rem",
		borderBottom: EDGE,
		color: "var(--compare-heading, inherit)",
		fontSize: "0.8rem",
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis",
	})
	const dot = document.createElement("span")
	dot.setAttribute("aria-hidden", "true")
	Object.assign(dot.style, {flex: "none", width: "7px", height: "7px", borderRadius: "50%"})
	const name = document.createElement("span")
	Object.assign(name.style, {overflow: "hidden", textOverflow: "ellipsis"})
	element.append(dot, name)
	return {
		element,
		show(text: string, colour: string) {
			name.textContent = text
			dot.style.background = colour
		},
	}
}

const LOCKED: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

// Marks what came from the other draft, so it isn't sent back.
const FROM_THEM = Annotation.define<boolean>()

// An edit is taken as lost if it isn't answered by then.
const EDIT_TIMEOUT_MS = 5000

/**
 * What's typed into the other version, asked of `element` as
 * `compare:edit`, and the other version as it comes back, which waits while
 * edits are on their way, so it doesn't undo them for a moment.
 */
function sendEdits(element: HTMLElement) {
	let pending = 0
	let waiting: {view: EditorView; text: string} | undefined
	const settled = () => {
		pending--
		if (pending > 0 || !waiting) return
		const {view, text} = waiting
		waiting = undefined
		follow(view, text)
	}
	return {
		extension: EditorView.updateListener.of(update => {
			const splices = update.transactions.flatMap(transaction =>
				transaction.docChanged && !transaction.annotation(FROM_THEM)
					? splicesOf(transaction.changes)
					: [],
			)
			if (!splices.length) return
			pending++
			let done = false
			const settle = () => {
				if (done) return
				done = true
				clearTimeout(timer)
				settled()
			}
			const timer = setTimeout(settle, EDIT_TIMEOUT_MS)
			request(element, {type: "compare:edit", splices}).then(settle, settle)
		}),
		receive(view: EditorView, text: string) {
			if (pending > 0) waiting = {view, text}
			else follow(view, text)
		},
	}
}

export type TextSplice = {path: string[]; index: number; remove: number; insert: string}

/**
 * `changes` as splices into the file's content, each made after the ones
 * before it, which moved what follows.
 */
export function splicesOf(changes: ChangeSet): TextSplice[] {
	const splices: TextSplice[] = []
	let shift = 0
	changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		const insert = inserted.toString()
		splices.push({path: ["content"], index: fromA + shift, remove: toA - fromA, insert})
		shift += insert.length - (toA - fromA)
	})
	return splices
}

/**
 * Brings `view` to `text` by changing only the stretch between what they
 * start and end with alike, so the selection stays where it was around it.
 * Kept out of the undo history.
 */
export function follow(view: EditorView, text: string) {
	const current = view.state.doc.toString()
	if (current === text) return
	const most = Math.min(current.length, text.length)
	let start = 0
	while (start < most && current.charCodeAt(start) === text.charCodeAt(start)) start++
	let end = 0
	while (
		end < most - start &&
		current.charCodeAt(current.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
	)
		end++
	// Never between the halves of a surrogate pair.
	if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--
	if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end))) end--
	view.dispatch({
		changes: {from: start, to: current.length - end, insert: text.slice(start, text.length - end)},
		annotations: [FROM_THEM.of(true), Transaction.addToHistory.of(false)],
	})
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// What's only in this version and only in the other, in the colours the
// panel showing it gives them: beside the other version, as added and
// removed, each side headed by its draft; inline, with nothing to say which
// is which, in the drafts' own colours.
const INSERTED = "var(--compare-inserted, #22bb22)"
const DELETED = "var(--compare-deleted, #ee4433)"
const OURS = "var(--compare-ours, #3b7dd8)"
const THEIRS = "var(--compare-theirs, #9b5de5)"
const tint = (colour: string, amount: number) =>
	`color-mix(in srgb, ${colour} ${amount}%, transparent)`
const underline = (colour: string) =>
	`linear-gradient(${tint(colour, 60)}, ${tint(colour, 60)}) bottom/100% 2px no-repeat !important`

const diffColours = (inserted: string, deleted: string) =>
	EditorView.theme({
		".cm-changedLine, .cm-inlineChangedLine": {
			backgroundColor: `${tint(inserted, 10)} !important`,
		},
		"&.cm-merge-a .cm-changedLine": {backgroundColor: `${tint(deleted, 9)} !important`},
		".cm-changedText": {background: underline(inserted)},
		"&.cm-merge-a .cm-changedText": {background: underline(deleted)},
		".cm-deletedChunk": {backgroundColor: `${tint(deleted, 9)} !important`},
		".cm-deletedChunk .cm-deletedText": {background: underline(deleted)},
		".cm-changedLineGutter": {background: `${inserted} !important`},
		"&.cm-merge-a .cm-changedLineGutter": {background: `${deleted} !important`},
		".cm-deletedLineGutter": {background: `${deleted} !important`},
	})

const DIFF_COLOURS = diffColours(INSERTED, DELETED)
const DRAFT_COLOURS = diffColours(OURS, THEIRS)

// Lines changed on both sides, rather than only added or only removed:
// beside the other version, they're marked in a colour of their own on
// each side, as are the parts of them that differ and their gutter.
const MODIFIED = "var(--compare-modified, #dba617)"
const modifiedLine = Decoration.line({class: "cm-modifiedLine"})
const modifiedGutter = new (class extends GutterMarker {
	elementClass = "cm-modifiedLineGutter"
})()

type Modified = {
	chunks: readonly Chunk[] | undefined
	lines: DecorationSet
	gutter: RangeSet<GutterMarker>
}

// Whether the chunk takes something out and puts something in, rather than
// only adding (or only removing) text, a line break at the end included.
function changedOnBoth(chunk: Chunk) {
	const removes = chunk.changes.some(change => change.fromA < change.toA)
	const inserts = chunk.changes.some(change => change.fromB < change.toB)
	return removes && inserts
}

function modifiedIn(state: EditorState): Modified {
	const found = getChunks(state)
	const lines = new RangeSetBuilder<Decoration>()
	const gutter = new RangeSetBuilder<GutterMarker>()
	if (found?.side) {
		for (const chunk of found.chunks) {
			if (!changedOnBoth(chunk)) continue
			const [from, end] =
				found.side === "a" ? [chunk.fromA, chunk.endA] : [chunk.fromB, chunk.endB]
			for (let at = from; at <= end && at <= state.doc.length; ) {
				const line = state.doc.lineAt(at)
				lines.add(line.from, line.from, modifiedLine)
				gutter.add(line.from, line.from, modifiedGutter)
				at = line.to + 1
			}
		}
	}
	return {chunks: found?.chunks, lines: lines.finish(), gutter: gutter.finish()}
}

const modifiedChunks = StateField.define<Modified>({
	create: modifiedIn,
	update(value, transaction) {
		if (getChunks(transaction.state)?.chunks !== value.chunks) return modifiedIn(transaction.state)
		if (!transaction.docChanged) return value
		return {
			chunks: value.chunks,
			lines: value.lines.map(transaction.changes),
			gutter: value.gutter.map(transaction.changes),
		}
	},
	provide: field => [
		EditorView.decorations.from(field, value => value.lines),
		gutterLineClass.from(field, value => value.gutter),
	],
})

/** The numbers of the lines marked as changed on both sides, in `state`. */
export function modifiedLines(state: EditorState): number[] {
	const numbers: number[] = []
	state.field(modifiedChunks, false)?.lines.between(0, state.doc.length, from => {
		numbers.push(state.doc.lineAt(from).number)
	})
	return numbers
}

const CHANGED_ON_BOTH: Extension = [
	modifiedChunks,
	EditorView.theme({
		"&.cm-merge-a .cm-modifiedLine, &.cm-merge-b .cm-modifiedLine": {
			backgroundColor: `${tint(MODIFIED, 14)} !important`,
		},
		"&.cm-merge-a .cm-modifiedLine .cm-changedText, &.cm-merge-b .cm-modifiedLine .cm-changedText": {
			background: underline(MODIFIED),
		},
		"&.cm-merge-a .cm-changeGutter .cm-modifiedLineGutter, &.cm-merge-b .cm-changeGutter .cm-modifiedLineGutter":
			{background: `${MODIFIED} !important`},
	}),
]
