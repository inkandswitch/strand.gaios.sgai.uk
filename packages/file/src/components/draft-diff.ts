// What each of two versions changed in a text file since the version both
// came from, their common ancestor, while the file is compared: marked in
// this version, alone (stacked) or beside the other, lined up and scrolling
// with it, and editable too where the other's handle can be written; or both
// versions' changes marked together in their own colours, read-only
// (combined). Unchanged stretches fold away while the mode's options say to.
// Only shows inside something answering `compare-mode:view` and `compare`,
// like the GAIOS dock while the checked-out overlay is compared.

import {createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor} from "solid-js"
import {Automerge} from "@automerge/automerge-repo/slim"
import {
	Annotation,
	ChangeSet,
	Compartment,
	EditorState,
	Facet,
	RangeSet,
	StateEffect,
	StateField,
	Text,
	Transaction,
	type Extension,
	type Range,
} from "@codemirror/state"
import {
	Decoration,
	EditorView,
	GutterMarker,
	WidgetType,
	gutter,
	type DecorationSet,
} from "@codemirror/view"
import {Chunk, MergeView, diff, type Change} from "@codemirror/merge"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"
import {commonAncestor} from "./ancestor"

// What the panel showing it says to draw, as this reads it.
type CompareView = {mode: string; options: {collapsed?: boolean} | null} | null

// The overlays, and the two versions compared, as this reads them.
type Overlay = string | null
type OverlaysState = {
	checkedOut: Overlay
	drafts: {url: string; name: string}[]
	merges: {url: string; source: Overlay; target: Overlay}[]
}
type Comparison = {a: Overlay; b: Overlay} | null
type Member = {url: string}

/** What the two versions are called: this view's, and the other's. */
type Names = {ours: string; theirs: string}

/**
 * The other version's text, the text both came from, how to show them,
 * whether to fold what didn't change, and how to change the other version,
 * where it can be. Empty text when the other version doesn't have the file.
 */
export type DraftCompare = {
	mode: "inline" | "side-by-side" | "stacked"
	original: string
	/** the common ancestor's text, which each version's changes are marked against */
	base: string
	collapsed: boolean
	/** splices the other version's text, where it can be changed */
	edit?: (splices: TextSplice[]) => void
	/** to head each side with, side by side */
	names: Names | null
}

const MODES = ["inline", "side-by-side", "stacked"] as const

const COLLAPSE = {margin: 3, minSize: 4}

// This version is read again this long after it last changed, for where it
// parted from the other.
const OURS_DEBOUNCE_MS = 300

type Handle = {
	url: string
	doc(): unknown
	isReadOnly?(): boolean
	change?(callback: (doc: unknown) => void): void
	on(event: "change", listener: () => void): void
	off(event: "change", listener: () => void): void
}

// Where a version of the file lives, as the overlay provider answers
// `repo:handle-descriptor`.
type Descriptor = {url: string; cloneUrl?: string}

// The repo a view is handed: Patchwork's, over the page's base repo.
type ViewRepo = {baseRepo?: ViewRepo; find(url: string): Promise<Handle>}

/**
 * Undefined unless the file is compared in a mode the editor shows.
 * `handle` is this version, to find where it parted from the other's;
 * without it, the other's version is taken as where it started.
 */
export function useDraftCompare(
	element: HTMLElement & {repo?: unknown},
	handle?: Handle,
): Accessor<DraftCompare | undefined> {
	const view = subscribe(element, {
		type: "compare-mode:view",
		modes: {inline: true, "side-by-side": true, stacked: true},
		draws: ["side-by-side"],
		collapses: [...MODES],
		prefers: "inline",
	}) as unknown as Accessor<CompareView | undefined>
	const comparison = subscribe(element, {type: "compare"}) as unknown as Accessor<Comparison | undefined>
	const overlays = subscribe(element, {type: "overlays"}) as unknown as Accessor<OverlaysState | undefined>
	// The other version: B to A's view, A to B's.
	const other = createMemo<{overlay: Overlay} | undefined>(
		() => {
			const current = comparison()
			const state = overlays()
			if (!current || !state) return undefined
			return {overlay: state.checkedOut === current.a ? current.b : current.a}
		},
		undefined,
		{equals: (x, y) => x?.overlay === y?.overlay},
	)
	const url = handle?.url ?? element.getAttribute("doc-url") ?? ""
	const members = createMemo(() => {
		const current = other()
		return current
			? (subscribe(element, {type: "overlay:members", overlay: current.overlay} as never) as unknown as Accessor<
					Member[] | undefined
				>)
			: undefined
	})
	const missing = () => {
		const listed = members()?.()
		if (!listed) return undefined
		const id = documentId(url)
		return !listed.some(member => documentId(member.url) === id)
	}

	// Where the other version lives: the overlay provider says, asked for
	// that version by name.
	const descriptor = createMemo(() => {
		const current = other()
		return current && url
			? (subscribe(element, {
					type: "repo:handle-descriptor",
					url: `automerge:${documentId(url)}`,
					overlay: current.overlay,
				} as never) as unknown as Accessor<Descriptor | undefined>)
			: undefined
	})

	// The other version's handle, and its text as it changes.
	const [theirHandle, setTheirHandle] = createSignal<Handle>()
	const [theirs, setTheirs] = createSignal<Automerge.Doc<FileDoc>>()
	createEffect(() => {
		const answer = descriptor()?.()
		const repo = element.repo as ViewRepo | undefined
		setTheirHandle(undefined)
		setTheirs(undefined)
		if (!answer || !repo) return
		let live = true
		let found: Handle | undefined
		const read = () => setTheirs(() => found?.doc() as Automerge.Doc<FileDoc>)
		;(repo.baseRepo ?? repo).find(answer.cloneUrl ?? answer.url).then(
			next => {
				if (!live) return
				found = next
				setTheirHandle(() => next)
				read()
				next.on("change", read)
			},
			error => console.warn("[file] couldn't read the version compared with", error),
		)
		onCleanup(() => {
			live = false
			found?.off("change", read)
		})
	})

	// Bumped a moment after this version last changed.
	const [changed, setChanged] = createSignal(0)
	if (handle) {
		let timer: ReturnType<typeof setTimeout> | undefined
		const bump = () => {
			clearTimeout(timer)
			timer = setTimeout(() => setChanged(count => count + 1), OURS_DEBOUNCE_MS)
		}
		handle.on("change", bump)
		onCleanup(() => {
			clearTimeout(timer)
			handle.off("change", bump)
		})
	}
	const ours = () => {
		changed()
		return handle?.doc() as Automerge.Doc<FileDoc> | undefined
	}
	const names = createMemo<Names | null>(
		() => {
			const state = overlays()
			const current = other()
			return state && current
				? {ours: overlayName(state, state.checkedOut), theirs: overlayName(state, current.overlay)}
				: null
		},
		null,
		{equals: (x, y) => x?.ours === y?.ours && x?.theirs === y?.theirs},
	)
	return createMemo<DraftCompare | undefined>(
		() => {
			const current = view()
			const mode = MODES.find(each => each === current?.mode)
			if (!current || !mode || !other()) return undefined
			const collapsed = !!current.options?.collapsed
			if (missing()) {
				// Nothing to have parted from: all of it is new here.
				return {mode, original: "", base: "", collapsed, names: names()}
			}
			const text = theirs()
			const writable = theirHandle()
			if (!text || !writable) return undefined
			const original = fileText(text)
			return {
				mode,
				original,
				base: ancestorText(ours(), text) ?? original,
				collapsed,
				edit: writable.change && !writable.isReadOnly?.() ? splices => spliceInto(writable, splices) : undefined,
				names: names(),
			}
		},
		undefined,
		{
			equals: (a, b) =>
				a?.mode === b?.mode &&
				a?.original === b?.original &&
				a?.base === b?.base &&
				a?.collapsed === b?.collapsed &&
				!a?.edit === !b?.edit &&
				a?.names?.ours === b?.names?.ours &&
				a?.names?.theirs === b?.names?.theirs,
		},
	)
}

// What an overlay is called: main, a draft's name, or a merge's two sides.
function overlayName(state: OverlaysState, overlay: Overlay): string {
	if (overlay === null) return "Main"
	const draft = state.drafts.find(entry => entry.url === overlay)
	if (draft) return draft.name
	const merge = state.merges.find(entry => entry.url === overlay)
	return merge ? `${overlayName(state, merge.source)} → ${overlayName(state, merge.target)}` : ""
}

function documentId(url: string) {
	return url.replace(/^automerge:/, "").split(/[/#]/)[0]
}

// The splices made to the other version's text, through its handle.
function spliceInto(handle: Handle, splices: TextSplice[]) {
	handle.change!(doc => {
		for (const each of splices)
			Automerge.splice(doc as Automerge.Doc<unknown>, each.path, each.index, each.remove, each.insert)
	})
}

// The file's text where `ours` and `theirs` parted, read from `theirs`,
// which has it all.
function ancestorText(
	ours: Automerge.Doc<FileDoc> | undefined,
	theirs: Automerge.Doc<FileDoc>,
): string | undefined {
	if (!ours) return undefined
	try {
		return fileText(Automerge.view(theirs, commonAncestor(ours, theirs)))
	} catch (error) {
		console.warn("[file] couldn't find where the drafts parted", error)
		return undefined
	}
}

/**
 * The editor for `doc`: on its own, with what this version changed marked
 * (stacked), or both versions' changes marked and nothing typed into it
 * (combined), or beside the other version, each marked with what it
 * changed, while it's side by side, which it's built for (see
 * `useDraftCompare`).
 */
export function diffEditor(config: {
	doc: string
	extensions: Extension[]
	/** for the other version beside it */
	besideExtensions: Extension[]
	compare: Accessor<DraftCompare | undefined>
	beside: boolean
}): {view: EditorView; dom: HTMLElement; views: EditorView[]; destroy(): void} {
	if (config.beside) return besideDiff(config)
	const marks = new Compartment()
	const view = new EditorView({
		doc: config.doc,
		extensions: [config.extensions, marks.of([])],
	})
	followAlone(view, marks, config.compare)
	return {view, dom: view.dom, views: [view], destroy: () => view.destroy()}
}

// How the editor on its own is marked: the shape of it, which reconfigures
// it, apart from the texts, which it's sent as they change.
const shapeOf = (current: DraftCompare | undefined) =>
	current && current.mode !== "side-by-side" ? `${current.mode} ${current.collapsed}` : ""

function followAlone(
	view: EditorView,
	compartment: Compartment,
	compare: Accessor<DraftCompare | undefined>,
) {
	createEffect(
		on(compare, (current, previous) => {
			const shape = shapeOf(current)
			const reshaped = shape !== shapeOf(previous)
			const effects: StateEffect<unknown>[] = []
			if (reshaped) {
				const marking =
					current?.mode === "inline"
						? [combined(current.base, current.original), LOCKED]
						: current?.mode === "stacked"
							? [ownChanges(current.base)]
							: []
				const folding = current?.collapsed && shape ? [collapseUnchanged] : []
				effects.push(compartment.reconfigure([marking, folding]))
			}
			if (current?.mode === "inline")
				effects.push(setCombined.of({base: current.base, theirs: current.original}))
			if (current?.mode === "stacked") effects.push(setBase.of(current.base))
			if (effects.length) view.dispatch({effects})
			// Starting to compare, or folding what's unchanged away or back,
			// the file shows from its very top.
			if (!shape || !reshaped) return
			view.dispatch({effects: EditorView.scrollIntoView(0, {y: "start"})})
			view.scrollDOM.scrollTop = 0
		}),
	)
}

// The editor goes first, as B, and the other version after it, as A, lined
// up by how they differ. Each side is one version, so it's marked against
// the other: lines that differ on both sides are yellow on both, the two
// alternatives facing each other; lines only one side has are green where
// its draft added them, red where the other draft took them out. What's
// typed into A goes into the other version, where it can.
function besideDiff(config: {
	doc: string
	extensions: Extension[]
	besideExtensions: Extension[]
	compare: Accessor<DraftCompare | undefined>
}) {
	const initial = untrack(config.compare)
	const writable = (current: DraftCompare | undefined) => !!current?.edit
	const lock = new Compartment()
	const theirs = sendEdits(() => config.compare()?.edit)
	const base = initial?.base ?? initial?.original ?? ""
	const merge = new MergeView({
		a: {
			doc: initial?.original ?? "",
			extensions: [
				lock.of(writable(initial) ? [] : LOCKED),
				config.besideExtensions,
				UNMARKED,
				versionMarks(base),
				theirs?.extension ?? [],
				EditorView.updateListener.of(update => {
					if (update.docChanged) otherChanged(merge.b, update.state.doc)
				}),
			],
		},
		b: {
			doc: config.doc,
			extensions: [
				config.extensions,
				UNMARKED,
				versionMarks(base),
				EditorView.updateListener.of(update => {
					if (update.docChanged) otherChanged(merge.a, update.state.doc)
				}),
			],
		},
		orientation: "b-a",
		highlightChanges: false,
		gutter: false,
		collapseUnchanged: initial?.collapsed ? COLLAPSE : undefined,
	})
	Object.assign(merge.dom.style, {flex: "1", minHeight: "0", overflow: "auto"})
	// Each side is marked against the other's text, told again once typing
	// settles.
	let pendingOther: ReturnType<typeof setTimeout> | undefined
	const otherChanged = (view: EditorView, doc: Text) => {
		clearTimeout(pendingOther)
		pendingOther = setTimeout(
			() => view.dispatch({effects: setOther.of(doc.toString())}),
			OTHER_DEBOUNCE_MS,
		)
	}
	merge.a.dispatch({effects: setOther.of(merge.b.state.doc.toString())})
	merge.b.dispatch({effects: setOther.of(merge.a.state.doc.toString())})

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
		ours.show(names.ours, OURS)
		other.show(names.theirs, THEIRS)
	})

	createEffect(
		on(
			() => config.compare()?.original,
			text => {
				if (text === undefined) return
				theirs.receive(merge.a, text)
			},
			{defer: true},
		),
	)
	createEffect(
		on(
			() => config.compare()?.base,
			text => {
				if (text === undefined) return
				for (const side of [merge.a, merge.b]) side.dispatch({effects: setBase.of(text)})
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
		destroy: () => {
			clearTimeout(pendingOther)
			merge.destroy()
		},
	}
}

// What's typed is let settle this long before the other side is marked again.
const OTHER_DEBOUNCE_MS = 150

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

// Marks what came from the other version, so it isn't sent back.
const FROM_THEM = Annotation.define<boolean>()

/**
 * What's typed into the other version, spliced into it through `edit`, and
 * the other version as it comes back.
 */
function sendEdits(edit: () => DraftCompare["edit"]) {
	return {
		extension: EditorView.updateListener.of(update => {
			const splices = update.transactions.flatMap(transaction =>
				transaction.docChanged && !transaction.annotation(FROM_THEM)
					? splicesOf(transaction.changes)
					: [],
			)
			if (splices.length) edit()?.(splices)
		}),
		receive(view: EditorView, text: string) {
			follow(view, text)
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

// What each version changed, in the colours the host gives them. A pane
// showing one version (on its own, or beside the other) marks added,
// removed, and changed-on-both-sides lines: its heading already says which
// version it is. Combined, both versions' changes share one text, so they're
// told apart by the versions' own colours, A's and B's.
const INSERTED = "var(--compare-added, #22bb22)"
const DELETED = "var(--compare-removed, #ee4433)"
const MODIFIED = "var(--compare-conflict, #dba617)"
const OURS = "var(--compare-a, #3b7dd8)"
const THEIRS = "var(--compare-b, #9b5de5)"
const tint = (colour: string, amount: number) =>
	`color-mix(in srgb, ${colour} ${amount}%, transparent)`
const underline = (colour: string) =>
	`linear-gradient(${tint(colour, 60)}, ${tint(colour, 60)}) bottom/100% 2px no-repeat`

// Text taken out, shown struck through where it was: in a line, or as lines
// of its own where whole lines went.
class Ghost extends WidgetType {
	constructor(
		readonly text: string,
		readonly className: string,
		readonly block: boolean,
	) {
		super()
	}
	eq(other: Ghost) {
		return other.text === this.text && other.className === this.className && other.block === this.block
	}
	toDOM() {
		const element = document.createElement(this.block ? "div" : "span")
		element.className = `cm-ghost ${this.className}`
		element.textContent = this.text
		return element
	}
	ignoreEvent() {
		return false
	}
}

// `text` shown at `at` in `doc`. Whole lines, taken out from the start of
// one, show as lines of their own before the line at `at`, or after the
// last line at the end.
function ghost(doc: Text, at: number, text: string, className: string, lineStart: boolean) {
	const line = doc.lineAt(at)
	if (lineStart && text.endsWith("\n") && at === line.from)
		return Decoration.widget({widget: new Ghost(text.slice(0, -1), className, true), block: true, side: -1}).range(at)
	if (text.startsWith("\n") && at === line.to && at === doc.length)
		return Decoration.widget({widget: new Ghost(text.slice(1), className, true), block: true, side: 1}).range(at)
	return Decoration.widget({widget: new Ghost(text, className, false), side: -1}).range(at)
}

const isLineStart = (doc: Text, at: number) => doc.lineAt(at).from === at

// Marked, and the lines they touch, so unchanged ones can fold away.
type Marks = {deco: DecorationSet; touched: readonly number[]}

const NONE: readonly number[] = []

// The lines marked, which don't fold away, nor do those around them.
const touchedBy = Facet.define<
	(state: EditorState) => readonly number[],
	(state: EditorState) => readonly number[]
>({combine: values => values[0] ?? (() => NONE)})

function touchedLines(doc: Text, ranges: readonly Range<Decoration>[]) {
	const lines = new Set<number>()
	for (const {from, to} of ranges) {
		const last = doc.lineAt(to).number
		for (let line = doc.lineAt(from).number; line <= last; line++) lines.add(line)
	}
	return [...lines].sort((x, y) => x - y)
}

// --- This draft's own changes: on its own, and side by side ---

const insertedLine = Decoration.line({class: "cm-insertedLine"})
const modifiedLine = Decoration.line({class: "cm-modifiedLine"})
const insertedText = Decoration.mark({class: "cm-insertedText"})
const marker = (className: string) =>
	new (class extends GutterMarker {
		elementClass = className
	})()
const insertedGutter = marker("cm-insertedLineGutter")
const modifiedGutter = marker("cm-modifiedLineGutter")
const deletedGutter = marker("cm-deletedLineGutter")

/** Sets the text both drafts came from. */
const setBase = StateEffect.define<string>()

type OwnChanges = Marks & {
	base: string
	baseText: Text
	chunks: readonly Chunk[]
	gutter: RangeSet<GutterMarker>
	modified: readonly number[]
}

// Whether the chunk takes something out and puts something in, rather than
// only adding (or only removing) text, a line break at the end included.
function changedOnBoth(chunk: Chunk) {
	const removes = chunk.changes.some(change => change.fromA < change.toA)
	const inserts = chunk.changes.some(change => change.fromB < change.toB)
	return removes && inserts
}

function addsTo(line: {from: number; to: number}, start: number, change: Change) {
	const [from, to] = [start + change.fromB, start + change.toB]
	if (from >= to) return false
	if (line.from === line.to) return from <= line.from && line.from < to
	return Math.max(from, line.from) < Math.min(to, line.to)
}

function ownChangesIn(base: string, baseText: Text, doc: Text, chunks: readonly Chunk[]): OwnChanges {
	const ranges: Range<Decoration>[] = []
	const gutters: Range<GutterMarker>[] = []
	const modified: number[] = []
	for (const chunk of chunks) {
		const both = changedOnBoth(chunk)
		if (chunk.fromB < chunk.toB) {
			for (let at = chunk.fromB; at <= chunk.endB; ) {
				const line = doc.lineAt(at)
				at = line.to + 1
				// Only adding, a line is only marked for what's added in it, not
				// for a line break added at its end.
				if (!both && !chunk.changes.some(change => addsTo(line, chunk.fromB, change))) continue
				ranges.push((both ? modifiedLine : insertedLine).range(line.from))
				gutters.push((both ? modifiedGutter : insertedGutter).range(line.from))
				if (both) modified.push(line.number)
			}
		} else {
			const at = Math.min(chunk.fromB, doc.length)
			gutters.push(deletedGutter.range(doc.lineAt(at).from))
		}
		for (const change of chunk.changes) {
			const from = chunk.fromB + change.fromB
			if (change.fromB < change.toB) ranges.push(insertedText.range(from, chunk.fromB + change.toB))
			if (change.fromA < change.toA) {
				const start = chunk.fromA + change.fromA
				const text = baseText.sliceString(start, chunk.fromA + change.toA)
				ranges.push(ghost(doc, Math.min(from, doc.length), text, "cm-deletedGhost", isLineStart(baseText, start)))
			}
		}
	}
	return {
		base,
		baseText,
		chunks,
		deco: Decoration.set(ranges, true),
		gutter: RangeSet.of(gutters, true),
		touched: touchedLines(doc, ranges),
		modified,
	}
}

const textOf = (text: string) => Text.of(text.split("\n"))

const linesOf = (text: Text) => text.toString().split("\n")

/**
 * How lines `b` differ from lines `a`, in line numbers (from 0): each line
 * stands for one character, so the diff can't split or shift a line.
 */
export function lineDiff(a: readonly string[], b: readonly string[]) {
	const codes = new Map<string, string>()
	const encode = (lines: readonly string[]) =>
		lines
			.map(line => {
				let code = codes.get(line)
				if (code === undefined) {
					// From U+0100, stepping over the surrogates.
					const n = 0x100 + codes.size
					code = String.fromCharCode(n < 0xd800 ? n : n + 0x800)
					codes.set(line, code)
				}
				return code
			})
			.join("")
	return diff(encode(a), encode(b))
}

function ownChangesFor(base: string, doc: Text) {
	const baseText = textOf(base)
	return ownChangesIn(base, baseText, doc, Chunk.build(baseText, doc))
}

const ownChangesField = StateField.define<OwnChanges>({
	create: state => ownChangesFor("", state.doc),
	update(value, transaction) {
		let base = value.base
		for (const effect of transaction.effects) if (effect.is(setBase)) base = effect.value
		if (base !== value.base) return ownChangesFor(base, transaction.state.doc)
		if (!transaction.docChanged) return value
		const doc = transaction.state.doc
		const chunks = Chunk.updateB(value.chunks, value.baseText, doc, transaction.changes)
		return ownChangesIn(base, value.baseText, doc, chunks)
	},
	provide: field => [
		EditorView.decorations.from(field, value => value.deco),
		touchedBy.of(state => state.field(field, false)?.touched ?? NONE),
	],
})

/** The numbers of the lines marked as changed on both sides, in `state`. */
export function modifiedLines(state: EditorState): readonly number[] {
	return state.field(ownChangesField, false)?.modified ?? NONE
}

/** What this draft changed since `base`, marked as it changes. */
function ownChanges(base: string): Extension {
	return [
		ownChangesField.init(state => ownChangesFor(base, state.doc)),
		gutter({
			class: "cm-ownChangeGutter",
			markers: view => view.state.field(ownChangesField).gutter,
		}),
		OWN_THEME,
	]
}

// Beats the merge view's own colouring, which is put out below.
const LINE = "&.cm-editor .cm-line"
const OWN_THEME = EditorView.theme({
	[`${LINE}.cm-insertedLine`]: {backgroundColor: `${tint(INSERTED, 10)} !important`},
	[`${LINE}.cm-modifiedLine`]: {backgroundColor: `${tint(MODIFIED, 14)} !important`},
	".cm-insertedText": {background: underline(INSERTED)},
	".cm-modifiedLine .cm-insertedText": {background: underline(MODIFIED)},
	".cm-deletedGhost": {
		backgroundColor: tint(DELETED, 9),
		textDecoration: `line-through ${tint(DELETED, 70)}`,
		opacity: "0.8",
	},
	"div.cm-deletedGhost": {padding: "0 2px 0 6px"},
	".cm-ownChangeGutter": {width: "3px", paddingLeft: "1px"},
	".cm-ownChangeGutter .cm-insertedLineGutter": {background: INSERTED},
	".cm-ownChangeGutter .cm-modifiedLineGutter": {background: MODIFIED},
	".cm-ownChangeGutter .cm-deletedLineGutter": {
		background: `linear-gradient(${DELETED}, ${DELETED}) top/100% 3px no-repeat`,
	},
})

// The merge view's own marks are of how the two versions differ, not what
// each draft changed: they're put out.
const UNMARKED = EditorView.theme({
	"&.cm-merge-a .cm-changedLine, &.cm-merge-b .cm-changedLine": {
		backgroundColor: "transparent !important",
	},
})

// --- One version against the other, side by side ---

/** Sets the other side's text, which this side is marked against. */
const setOther = StateEffect.define<string>()

const differsLine = Decoration.line({class: "cm-differsLine"})
const addedLine = Decoration.line({class: "cm-addedLine"})
const removedLine = Decoration.line({class: "cm-removedLine"})

type VersionMarks = Marks & {base: string; other: string}

/**
 * This side's lines marked against `other`'s, line by line: where both
 * sides have lines, they differ (yellow); where only this side has them,
 * they're added if they aren't in `base` (this draft added them), else
 * removed (the other draft took them out).
 */
export function versionRanges(base: string, doc: Text, other: string): Range<Decoration>[] {
	const ranges: Range<Decoration>[] = []
	const lines = linesOf(doc)
	// The lines this side's draft added since the ancestor.
	const added = new Set<number>()
	for (const change of lineDiff(base.split("\n"), lines))
		for (let line = change.fromB; line < change.toB; line++) added.add(line)
	for (const change of lineDiff(other.split("\n"), lines)) {
		const both = change.fromA < change.toA
		for (let line = change.fromB; line < change.toB; line++) {
			const decoration = both ? differsLine : added.has(line) ? addedLine : removedLine
			ranges.push(decoration.range(doc.line(line + 1).from))
		}
	}
	return ranges
}

function versionMarksFor(base: string, other: string, doc: Text): VersionMarks {
	const ranges = versionRanges(base, doc, other)
	return {base, other, deco: Decoration.set(ranges, true), touched: touchedLines(doc, ranges)}
}

const versionMarksField = StateField.define<VersionMarks>({
	create: state => versionMarksFor("", state.doc.toString(), state.doc),
	update(value, transaction) {
		let {base, other} = value
		for (const effect of transaction.effects) {
			if (effect.is(setBase)) base = effect.value
			if (effect.is(setOther)) other = effect.value
		}
		if (base === value.base && other === value.other && !transaction.docChanged) return value
		return versionMarksFor(base, other, transaction.state.doc)
	},
	provide: field => [
		EditorView.decorations.from(field, value => value.deco),
		touchedBy.of(state => state.field(field, false)?.touched ?? NONE),
	],
})

/** This side, marked against the other side's text (sent with `setOther`). */
function versionMarks(base: string): Extension {
	return [versionMarksField.init(state => versionMarksFor(base, state.doc.toString(), state.doc)), VERSION_THEME]
}

const VERSION_THEME = EditorView.theme({
	[`${LINE}.cm-differsLine`]: {
		backgroundColor: `${tint(MODIFIED, 18)} !important`,
		boxShadow: `inset 3px 0 ${MODIFIED}`,
	},
	[`${LINE}.cm-addedLine`]: {
		backgroundColor: `${tint(INSERTED, 12)} !important`,
		boxShadow: `inset 3px 0 ${INSERTED}`,
	},
	[`${LINE}.cm-removedLine`]: {
		backgroundColor: `${tint(DELETED, 10)} !important`,
		boxShadow: `inset 3px 0 ${DELETED}`,
	},
})

// --- Both drafts' changes, combined in this draft's text ---

/** Sets the text both drafts came from, and the other draft's. */
const setCombined = StateEffect.define<{base: string; theirs: string}>()

type Combined = Marks & {base: string; theirs: string}

const oursLine = Decoration.line({class: "cm-oursLine"})

/**
 * Where this draft's text and the other's differ, line by line, both
 * versions as alternatives: this draft's lines where they are, and the
 * other's, as lines of their own, right after them (or where they'd be).
 * Nothing's struck out; each is in its version's colour.
 */
export function combinedRanges(ours: Text, theirs: string): Range<Decoration>[] {
	const theirLines = theirs.split("\n")
	const ranges: Range<Decoration>[] = []
	for (const change of lineDiff(theirLines, linesOf(ours))) {
		for (let line = change.fromB; line < change.toB; line++)
			ranges.push(oursLine.range(ours.line(line + 1).from))
		if (change.fromA >= change.toA) continue
		const widget = new Ghost(theirLines.slice(change.fromA, change.toA).join("\n"), "cm-theirsLines", true)
		ranges.push(
			change.toB > change.fromB
				? // right after this draft's alternative
					Decoration.widget({widget, block: true, side: 1}).range(ours.line(change.toB).to)
				: change.fromB < ours.lines
					? // where they'd be: before the line that follows them here
						Decoration.widget({widget, block: true, side: -1}).range(ours.line(change.fromB + 1).from)
					: Decoration.widget({widget, block: true, side: 1}).range(ours.length),
		)
	}
	return ranges
}

function combinedFor(base: string, theirs: string, doc: Text): Combined {
	const ranges = combinedRanges(doc, theirs)
	return {base, theirs, deco: Decoration.set(ranges, true), touched: touchedLines(doc, ranges)}
}

const combinedField = StateField.define<Combined>({
	create: state => combinedFor("", state.doc.toString(), state.doc),
	update(value, transaction) {
		let {base, theirs} = value
		for (const effect of transaction.effects)
			if (effect.is(setCombined)) ({base, theirs} = effect.value)
		if (base === value.base && theirs === value.theirs && !transaction.docChanged) return value
		return combinedFor(base, theirs, transaction.state.doc)
	},
	provide: field => [
		EditorView.decorations.from(field, value => value.deco),
		touchedBy.of(state => state.field(field, false)?.touched ?? NONE),
	],
})

function combined(base: string, theirs: string): Extension {
	return [combinedField.init(state => combinedFor(base, theirs, state.doc)), COMBINED_THEME]
}

const COMBINED_THEME = EditorView.theme({
	"&": {"--combined-ours": OURS, "--combined-theirs": THEIRS},
	[`${LINE}.cm-oursLine`]: {
		backgroundColor: `${tint("var(--combined-ours)", 12)} !important`,
		boxShadow: "inset 3px 0 var(--combined-ours)",
	},
	"div.cm-theirsLines": {
		padding: "0 2px 0 6px",
		whiteSpace: "pre-wrap",
		backgroundColor: tint("var(--combined-theirs)", 12),
		boxShadow: "inset 3px 0 var(--combined-theirs)",
	},
})

// --- Folding away what's unchanged, on its own ---

const unfold = StateEffect.define<number>({map: (at, changes) => changes.mapPos(at)})

class Folded extends WidgetType {
	constructor(readonly lines: number) {
		super()
	}
	eq(other: Folded) {
		return other.lines === this.lines
	}
	toDOM(view: EditorView) {
		const element = document.createElement("div")
		element.className = "cm-collapsedLines"
		element.textContent = view.state.phrase("$ unchanged lines", this.lines)
		element.addEventListener("click", event => {
			view.dispatch({effects: unfold.of(view.posAtDOM(event.target as Node))})
		})
		return element
	}
	ignoreEvent(event: Event) {
		return event instanceof MouseEvent
	}
	get estimatedHeight() {
		return 27
	}
}

function foldedIn(state: EditorState, touched: readonly number[], unfolded: readonly number[]) {
	const {doc} = state
	const ranges: Range<Decoration>[] = []
	let after = 0
	for (const line of [...touched, null]) {
		const first = after ? after + COLLAPSE.margin + 1 : 1
		const last = line === null ? doc.lines : line - COLLAPSE.margin - 1
		const from = first <= doc.lines ? doc.line(first).from : -1
		if (last - first + 1 >= COLLAPSE.minSize && !unfolded.includes(from))
			ranges.push(
				Decoration.replace({widget: new Folded(last - first + 1), block: true}).range(from, doc.line(last).to),
			)
		if (line !== null) after = line
	}
	return Decoration.set(ranges)
}

type Folding = {deco: DecorationSet; touched: readonly number[]; unfolded: readonly number[]}

const collapseUnchanged = [
	StateField.define<Folding>({
		create(state) {
			const touched = state.facet(touchedBy)(state)
			return {deco: foldedIn(state, touched, NONE), touched, unfolded: NONE}
		},
		update(value, transaction) {
			let unfolded = transaction.docChanged
				? value.unfolded.map(at => transaction.changes.mapPos(at))
				: value.unfolded
			for (const effect of transaction.effects) if (effect.is(unfold)) unfolded = [...unfolded, effect.value]
			const touched = transaction.state.facet(touchedBy)(transaction.state)
			if (touched === value.touched && unfolded === value.unfolded) return value
			return {deco: foldedIn(transaction.state, touched, unfolded), touched, unfolded}
		},
		provide: field => EditorView.decorations.from(field, value => value.deco),
	}),
	EditorView.theme({
		".cm-collapsedLines": {
			padding: "5px 5px 5px 10px",
			cursor: "pointer",
			fontSize: "90%",
			opacity: "0.7",
			background: "var(--compare-folded, rgb(128 128 128 / 0.08))",
		},
	}),
]
