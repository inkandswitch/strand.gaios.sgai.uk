// What each of two versions changed in a text file since the version both
// came from, their common ancestor, while the file is compared: marked in
// this version, alone (stacked) or beside the other, lined up and scrolling
// with it, and editable too where the other's handle can be written; or both
// versions' changes marked together in their own colours, read-only
// (combined). Unchanged stretches fold away while the mode's options say to.
// Only shows inside something answering `compare-mode:view` and `compare`,
// like the GAIOS dock while the checked-out overlay is compared.
//
// A merge compared with its target reads before (the target) to after (the
// merge): the target first and read-only, what the merge does to it marked
// as added and removed, and the merge's conflicts in this file marked where
// they are, with each side's lines to take.

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
import {Chunk, MergeView, diff, getChunks, type Change} from "@codemirror/merge"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"
import {commonAncestor} from "./ancestor"

// What the panel showing it says to draw, as this reads it.
type CompareView = {mode: string; options: {collapsed?: boolean} | null} | null

// The overlays, and the two versions compared, as this reads them.
type Overlay = string | null
// A point in an overlay's history; null for its working copy.
type At = string | null
type OverlaysState = {
	checkedOut: Overlay
	at?: At
	drafts: {url: string; name: string}[]
	merges: {url: string; source: Overlay; target: Overlay}[]
}
type Comparison =
	| {kind: "compare"; a: Overlay; b: Overlay; aAt?: At; bAt?: At}
	| {kind: "merge"; a: string; b: Overlay; source: Overlay; target: Overlay; published: boolean}
	| null
type Member = {url: string}

/** What the two versions are called: this view's, and the other's. */
type Names = {ours: string; theirs: string}

// The overlay provider's `merge:conflicts`, as this reads it.
type ConflictState = "open" | "source" | "target" | "both" | "edited"
type MergeConflicts = Record<
	string,
	{
		at: {path: string[]; from?: string; to?: string}
		source: unknown
		target: unknown
		both?: unknown
		state: ConflictState
	}[]
>

/** What a conflict can be resolved to: one side's lines, or both. */
export type ConflictOption = "target" | "source" | "both"

/**
 * A conflict of the merge in this file: where it is in the text now, each
 * side's lines there, and which way it went.
 */
export type TextConflict = {
	from: number
	to: number
	source: string
	target: string
	/** the target's lines, then the source's */
	both: string
	state: ConflictState
	/** where it is in before's text, the target's */
	before?: {from: number; to: number}
}

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
	/** a merge, compared with its target: before is the other version, after this one */
	merging: boolean
	/** a merge's conflicts in this file, what its sides are called, and taking one */
	conflicts: TextConflict[]
	sides?: {source: string; target: string}
	take?: (conflict: TextConflict, option: ConflictOption) => void
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
	// The other version: B to A's view, A to B's. Two points in one overlay's
	// history are told apart by the point.
	const isA = () => {
		const current = comparison()
		const state = overlays()
		if (!current || !state) return false
		if (current.kind === "merge") return state.checkedOut === current.a
		return state.checkedOut === current.a && (state.at ?? null) === (current.aAt ?? null)
	}
	const other = createMemo<{overlay: Overlay; at: At} | undefined>(
		() => {
			const current = comparison()
			if (!current || !overlays()) return undefined
			if (isA()) return {overlay: current.b, at: current.kind === "compare" ? (current.bAt ?? null) : null}
			return {overlay: current.a, at: current.kind === "compare" ? (current.aAt ?? null) : null}
		},
		undefined,
		{equals: (x, y) => x?.overlay === y?.overlay && x?.at === y?.at},
	)
	// Two points in one overlay's history, as A (the later) shows them: from
	// B to A, like a merge from before to after.
	const history = createMemo(() => {
		const current = comparison()
		return current?.kind === "compare" && current.a === current.b && isA()
	})
	const url = handle?.url ?? element.getAttribute("doc-url") ?? ""
	const members = createMemo(() => {
		const current = other()
		return current
			? (subscribe(element, {
					type: "overlay:members",
					overlay: current.overlay,
					at: current.at,
				} as never) as unknown as Accessor<
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
					at: current.at,
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

	// A merge shown against its target: this view is after, the other before.
	// The comparison says so; this view is after when it's the merge's own.
	const merge = createMemo(
		() => {
			const current = comparison()
			return current?.kind === "merge" && overlays()?.checkedOut === current.a
				? {url: current.a, source: current.source, target: current.target}
				: undefined
		},
		undefined,
		{equals: (x, y) => x?.url === y?.url && x?.source === y?.source && x?.target === y?.target},
	)
	const mergeConflicts = createMemo(() => {
		const current = merge()
		return current
			? (subscribe(element, {type: "merge:conflicts", merge: current.url} as never) as unknown as Accessor<
					MergeConflicts | undefined
				>)
			: undefined
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
			if (!state || !current) return null
			if (merge() || history()) return {ours: "After", theirs: "Before"}
			return {ours: overlayName(state, state.checkedOut), theirs: overlayName(state, current.overlay)}
		},
		null,
		{equals: (x, y) => x?.ours === y?.ours && x?.theirs === y?.theirs},
	)
	// This file's conflicts, placed in the text as it is now.
	const conflicts = createMemo<TextConflict[]>(
		() => {
			const listed = mergeConflicts()?.()
			const doc = ours()
			if (!listed || !doc) return []
			const before = theirs()
			const id = documentId(url)
			const mine = Object.entries(listed).find(([member]) => documentId(member) === id)?.[1] ?? []
			return mine.flatMap(conflict => {
				const range = placeIn(doc, conflict.at)
				const {source, target} = conflict
				if (!range || typeof source !== "string" || typeof target !== "string") return []
				const both = typeof conflict.both === "string" ? conflict.both : `${target}\n${source}`
				const where = before ? placeIn(before, conflict.at) : undefined
				return [{...range, source, target, both, state: conflict.state, before: where}]
			})
		},
		[],
		{equals: (x, y) => JSON.stringify(x) === JSON.stringify(y)},
	)
	const sides = createMemo(
		() => {
			const state = overlays()
			const merging = merge()
			return state && merging
				? {source: overlayName(state, merging.source), target: overlayName(state, merging.target)}
				: undefined
		},
		undefined,
		{equals: (x, y) => x?.source === y?.source && x?.target === y?.target},
	)
	// Taking a side, or both, writes its lines over the conflict, even where
	// they're there already: that's what says it was taken.
	const take = (conflict: TextConflict, option: ConflictOption) => {
		if (!handle?.change) return
		handle.change(doc => {
			const text = fileText(doc as Automerge.Doc<FileDoc>)
			const to = Math.min(conflict.to, text.length)
			Automerge.splice(doc as Automerge.Doc<unknown>, ["content"], conflict.from, to - conflict.from, conflict[option])
		})
	}

	return createMemo<DraftCompare | undefined>(
		() => {
			const current = view()
			const mode = MODES.find(each => each === current?.mode)
			if (!current || !mode || !other()) return undefined
			const collapsed = !!current.options?.collapsed
			// Two points in history read like a merge with nothing to resolve.
			const merging = !!merge() || history()
			const mergeParts = merge() ? {conflicts: conflicts(), sides: sides(), take} : {conflicts: []}
			if (missing()) {
				// Nothing to have parted from: all of it is new here.
				return {mode, original: "", base: "", collapsed, names: names(), merging, ...mergeParts}
			}
			const text = theirs()
			const writable = theirHandle()
			if (!text || !writable) return undefined
			const original = fileText(text)
			return {
				mode,
				original,
				// A merge is marked against before: what it does to the target.
				base: merging ? original : (ancestorText(ours(), text) ?? original),
				collapsed,
				// Before is the target, which a merge leaves alone until it's accepted.
				edit:
					!merging && writable.change && !writable.isReadOnly?.()
						? splices => spliceInto(writable, splices)
						: undefined,
				names: names(),
				merging,
				...mergeParts,
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
				a?.names?.theirs === b?.names?.theirs &&
				a?.merging === b?.merging &&
				a?.sides?.source === b?.sides?.source &&
				a?.sides?.target === b?.sides?.target &&
				JSON.stringify(a?.conflicts) === JSON.stringify(b?.conflicts),
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

// Where a conflict's place is in `doc`'s text: strictly between the
// characters its cursors name, "start" and "end" being the text's ends.
function placeIn(
	doc: Automerge.Doc<FileDoc>,
	at: {path: string[]; from?: string; to?: string},
): {from: number; to: number} | undefined {
	const length = fileText(doc).length
	try {
		const from =
			at.from === undefined || at.from === "start"
				? 0
				: Automerge.getCursorPosition(doc, at.path, at.from) + 1
		const to =
			at.to === undefined || at.to === "end" ? length : Automerge.getCursorPosition(doc, at.path, at.to)
		return {from: Math.min(from, length), to: Math.max(Math.min(to, length), Math.min(from, length))}
	} catch {
		return undefined
	}
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
		extensions: [config.extensions, marks.of([]), conflictMarks],
	})
	followAlone(view, marks, config.compare)
	followConflicts(view, config.compare)
	return {view, dom: view.dom, views: [view], destroy: () => view.destroy()}
}

// How the editor on its own is marked: the shape of it, which reconfigures
// it, apart from the texts, which it's sent as they change.
const shapeOf = (current: DraftCompare | undefined) =>
	current && current.mode !== "side-by-side" ? `${current.mode} ${current.collapsed} ${current.merging}` : ""

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
						? [combined(current.base, current.original), LOCKED, merged(current.merging)]
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
	// Folding what's unchanged: the merge view's own, or, showing a merge,
	// ours, which keeps its conflicts open.
	const foldsItself = (current: DraftCompare | undefined) => !!current?.collapsed && !current.merging
	const foldsOurs = (current: DraftCompare | undefined) => !!current?.collapsed && !!current.merging
	const foldA = new Compartment()
	const foldB = new Compartment()
	const theirs = sendEdits(() => config.compare()?.edit)
	const base = initial?.base ?? initial?.original ?? ""
	const merge = new MergeView({
		a: {
			doc: initial?.original ?? "",
			extensions: [
				foldA.of(foldsOurs(initial) ? foldBeside() : []),
				lock.of(writable(initial) ? [] : LOCKED),
				config.besideExtensions,
				beforeMarks,
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
				conflictMarks,
				foldB.of(foldsOurs(initial) ? foldBeside() : []),
				EditorView.updateListener.of(update => {
					if (update.docChanged) otherChanged(merge.a, update.state.doc)
				}),
			],
		},
		// This version first, unless it's a merge's after: before comes first.
		orientation: initial?.merging ? "a-b" : "b-a",
		highlightChanges: false,
		gutter: false,
		collapseUnchanged: foldsItself(initial) ? COLLAPSE : undefined,
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
	frame.append(headings, merge.dom)
	createEffect(() => {
		const current = config.compare()
		const names = current?.names
		headings.hidden = !names
		if (!names) return
		if (current.merging) {
			// Before shows both sides' lines where they conflict; after counts
			// the conflicts still open.
			const conflicted = current.conflicts.length > 0
			other.show(names.theirs, conflicted ? [TARGET, SOURCE] : [], true)
			ours.show(names.ours, [], true)
			ours.count(current.conflicts.filter(conflict => conflict.state === "open").length)
		} else {
			ours.show(names.ours, [OURS])
			other.show(names.theirs, [THEIRS])
			ours.count(0)
		}
	})
	createEffect(
		on(
			() => !!config.compare()?.merging,
			merging => {
				merge.reconfigure({orientation: merging ? "a-b" : "b-a"})
				const [first, second] = merging ? [other, ours] : [ours, other]
				first.element.style.borderLeft = ""
				second.element.style.borderLeft = EDGE
				headings.replaceChildren(first.element, second.element)
			},
		),
	)
	followConflicts(merge.b, config.compare)
	followConflicts(merge.a, config.compare)

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
			() => `${foldsItself(config.compare())} ${foldsOurs(config.compare())}`,
			() => {
				const current = untrack(config.compare)
				merge.reconfigure({collapseUnchanged: foldsItself(current) ? COLLAPSE : undefined})
				const ours = foldsOurs(current) ? foldBeside() : []
				merge.a.dispatch({effects: foldA.reconfigure(ours)})
				merge.b.dispatch({effects: foldB.reconfigure(foldsOurs(current) ? foldBeside() : [])})
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

// A side's heading: its version's colour dot and name, or, a merge's, the
// name with the colours of the sides shown after it, and the conflicts still
// open at its end.
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
	const dotsBefore = document.createElement("span")
	const name = document.createElement("span")
	Object.assign(name.style, {overflow: "hidden", textOverflow: "ellipsis"})
	const dotsAfter = document.createElement("span")
	for (const dots of [dotsBefore, dotsAfter]) {
		dots.setAttribute("aria-hidden", "true")
		Object.assign(dots.style, {display: "inline-flex", gap: "2px", flex: "none"})
	}
	const badge = document.createElement("span")
	Object.assign(badge.style, {
		marginLeft: "auto",
		display: "inline-flex",
		alignItems: "center",
		gap: "0.3em",
		fontWeight: "600",
	})
	badge.append(stateIcon("open"), document.createTextNode(""))
	element.append(dotsBefore, name, dotsAfter, badge)
	const dot = (colour: string) => {
		const each = document.createElement("span")
		Object.assign(each.style, {width: "7px", height: "7px", borderRadius: "50%", background: colour})
		return each
	}
	return {
		element,
		show(text: string, colours: string[], after = false) {
			name.textContent = text
			;(after ? dotsAfter : dotsBefore).replaceChildren(...colours.map(dot))
			;(after ? dotsBefore : dotsAfter).replaceChildren()
		},
		count(open: number) {
			badge.hidden = open === 0
			badge.lastChild!.textContent = String(open)
			badge.title = open === 1 ? "1 conflict to resolve" : `${open} conflicts to resolve`
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
const NEUTRAL = "var(--compare-neutral, #8a8883)"
const CONFLICT = MODIFIED

// A merge, combined: what it leaves added, what it replaces removed, rather
// than in the versions' colours (see COMBINED_THEME).
const merged = (merging: boolean): Extension =>
	merging ? EditorView.editorAttributes.of({class: "cm-diff-merge"}) : []
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

// The lines marked, which don't fold away, nor do those around them: every
// source's together (what changed, and a merge's conflicts).
const touchedBy = Facet.define<
	(state: EditorState) => readonly number[],
	(state: EditorState) => readonly number[]
>({
	combine: values =>
		values.length === 0
			? () => NONE
			: values.length === 1
				? values[0]
				: state => {
						const lines = new Set<number>()
						for (const of of values) for (const line of of(state)) lines.add(line)
						return [...lines].sort((x, y) => x - y)
					},
})

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
	"&.cm-diff-merge": {"--combined-ours": INSERTED, "--combined-theirs": DELETED},
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

// --- A merge's conflicts ---
//
// After (the merge) shows each conflict headed by a row offering the target's
// lines, the source's, or both, with a mark in the gutter saying how it went.
// Open, its lines are hidden under a hatch: what Automerge made of them
// isn't anything to read. Hovering an option shows its lines in their place,
// writing nothing; taking it writes them, each line in its side's colour
// until it's edited. Before (the target) shows the target's lines there,
// then the source's after them.

// The two sides, in their colours: the target is what a merge changes, the
// source what it brings.
const TARGET = OURS
const SOURCE = THEIRS

type ConflictsShown = {
	conflicts: TextConflict[]
	sides?: DraftCompare["sides"]
	take?: DraftCompare["take"]
}

type Preview = {index: number; option: ConflictOption} | null

const setConflicts = StateEffect.define<ConflictsShown>()
const setPreview = StateEffect.define<Preview>()

type AfterState = {shown: ConflictsShown; preview: Preview; marks: DecorationSet}

const afterField = StateField.define<AfterState>({
	create: () => ({shown: {conflicts: []}, preview: null, marks: Decoration.none}),
	update(value, transaction) {
		let {shown, preview} = value
		let changed = transaction.docChanged
		// Typing moves the conflicts until they're worked out again: what's
		// typed at either end of one is inside it.
		if (transaction.docChanged)
			shown = {
				...shown,
				conflicts: shown.conflicts.map(conflict => ({
					...conflict,
					from: transaction.changes.mapPos(conflict.from, -1),
					to: transaction.changes.mapPos(conflict.to, 1),
				})),
			}
		for (const effect of transaction.effects) {
			if (effect.is(setConflicts)) {
				shown = effect.value
				if (preview && preview.index >= shown.conflicts.length) preview = null
				changed = true
			}
			if (effect.is(setPreview)) {
				preview = effect.value
				changed = true
			}
		}
		return changed ? {shown, preview, marks: afterMarks(transaction.state.doc, shown, preview)} : value
	},
	provide: field => EditorView.decorations.from(field, value => value.marks),
})

const CONFLICT_THEME = EditorView.theme({
	".cm-conflictGutter .cm-gutterElement": {display: "flex", alignItems: "center", justifyContent: "center"},
	".cm-conflictChips": {
		display: "flex",
		alignItems: "center",
		gap: "0.4rem",
		padding: "0.3rem 0.5rem",
		fontFamily: "system-ui, sans-serif",
		fontSize: "0.8rem",
	},
	".cm-conflictHatch, .cm-conflictChips.cm-conflictOpen": {
		backgroundImage: `repeating-linear-gradient(135deg, ${tint(CONFLICT, 22)} 0 6px, ${tint(CONFLICT, 8)} 6px 12px)`,
		boxShadow: `inset 3px 0 ${CONFLICT}`,
	},
	".cm-conflictHatch": {minHeight: "1.4em"},
	".cm-conflictChip": {
		display: "inline-flex",
		alignItems: "center",
		gap: "0.35em",
		padding: "0.15rem 0.6rem",
		border: "1px solid var(--compare-edge, rgb(0 0 0 / 0.15))",
		borderRadius: "999px",
		background: "var(--compare-chip, rgb(255 255 255 / 0.85))",
		color: "inherit",
		font: "inherit",
		cursor: "pointer",
	},
	".cm-conflictChip[data-previewed]": {borderColor: "var(--chip-colour)"},
	".cm-conflictChip[aria-pressed=true]": {
		borderColor: "var(--chip-colour)",
		background: tint("var(--chip-colour)", 14),
		fontWeight: "600",
	},
	".cm-conflictRing": {
		width: "7px",
		height: "7px",
		borderRadius: "50%",
		border: "1.5px solid var(--ring-colour)",
		boxSizing: "border-box",
	},
	".cm-conflictChip[data-previewed] .cm-conflictRing, .cm-conflictChip[aria-pressed=true] .cm-conflictRing": {
		background: "var(--ring-colour)",
	},
	[`${LINE}.cm-conflictTarget`]: {
		backgroundColor: `${tint(TARGET, 10)} !important`,
		boxShadow: `inset 3px 0 ${TARGET}`,
	},
	[`${LINE}.cm-conflictSource`]: {
		backgroundColor: `${tint(SOURCE, 10)} !important`,
		boxShadow: `inset 3px 0 ${SOURCE}`,
	},
	".cm-conflictPreviewLine": {
		padding: "0 2px 0 6px",
		whiteSpace: "pre-wrap",
		opacity: "0.6",
		borderLeft: "3px dotted var(--line-colour)",
		backgroundColor: tint("var(--line-colour)", 6),
	},
	".cm-conflictBefore": {
		padding: "0 2px 0 6px",
		whiteSpace: "pre-wrap",
		backgroundColor: tint(SOURCE, 10),
		boxShadow: `inset 3px 0 ${SOURCE}`,
	},
	".cm-conflictLabel": {
		float: "right",
		paddingLeft: "1em",
		fontFamily: "system-ui, sans-serif",
		fontSize: "0.75rem",
		color: "var(--label-colour)",
	},
	".cm-conflictIcon": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: "16px",
		height: "16px",
		borderRadius: "50%",
		fontSize: "10px",
		lineHeight: "1",
		fontFamily: "system-ui, sans-serif",
		boxSizing: "border-box",
	},
	".cm-conflictIcon-open": {background: CONFLICT, color: "white"},
	".cm-conflictIcon-taken": {border: `1.5px solid ${INSERTED}`, color: INSERTED},
	".cm-conflictIcon-edited": {border: `1.5px solid ${NEUTRAL}`, color: NEUTRAL},
})

// A conflict's lines, open or resolved, never fold away: resolved to what
// before has, they'd read as unchanged.
const afterTouched = (state: EditorState): readonly number[] => {
	const shown = state.field(afterField, false)?.shown
	if (!shown?.conflicts.length) return NONE
	return rangeLines(state.doc, shown.conflicts)
}

function rangeLines(doc: Text, ranges: readonly {from: number; to: number}[]): readonly number[] {
	const lines = new Set<number>()
	for (const range of ranges) {
		const {first, last} = conflictLines(doc, range)
		for (let line = first.number; line <= last.number; line++) lines.add(line)
	}
	return [...lines].sort((x, y) => x - y)
}

/** After's conflicts: the rows, hatches, previews and line colours, and the gutter marks. */
const conflictMarks: Extension = [
	afterField,
	touchedBy.of(afterTouched),
	gutter({
		class: "cm-conflictGutter",
		widgetMarker: (_view, widget) => (widget instanceof ConflictChips ? new StateMarker(widget.conflict.state) : null),
		lineMarkerChange: update =>
			update.transactions.some(transaction =>
				transaction.effects.some(effect => effect.is(setConflicts) || effect.is(setPreview)),
			),
	}),
	CONFLICT_THEME,
]

// The lines a conflict covers, from its first to its last, in `doc`.
function conflictLines(doc: Text, range: {from: number; to: number}) {
	const from = Math.min(range.from, doc.length)
	const to = Math.min(Math.max(range.to, from), doc.length)
	return {first: doc.lineAt(from), last: doc.lineAt(to)}
}

// Each option's lines, in its side's colour.
function optionLines(conflict: TextConflict, option: ConflictOption): {text: string; colour: string}[] {
	const lines = (text: string, colour: string) => (text ? text.split("\n").map(line => ({text: line, colour})) : [])
	if (option === "target") return lines(conflict.target, TARGET)
	if (option === "source") return lines(conflict.source, SOURCE)
	return [...lines(conflict.target, TARGET), ...lines(conflict.source, SOURCE)]
}

export function afterMarks(doc: Text, shown: ConflictsShown, preview: Preview): DecorationSet {
	const ranges: Range<Decoration>[] = []
	shown.conflicts.forEach((conflict, index) => {
		const {first, last} = conflictLines(doc, conflict)
		const previewed = preview?.index === index ? preview.option : null
		ranges.push(
			Decoration.widget({
				widget: new ConflictChips(index, conflict, shown, previewed),
				block: true,
				side: -1,
			}).range(first.from),
		)
		// What shows where its lines are: an option being previewed, the
		// hatch while it's open, or its lines, each in the colour of the side
		// it came from until it's edited.
		const cover = previewed
			? new PreviewLines(optionLines(conflict, previewed))
			: conflict.state === "open"
				? new Hatch()
				: null
		if (cover) {
			ranges.push(
				first.from === last.to
					? Decoration.widget({widget: cover, block: true, side: 1}).range(first.from)
					: Decoration.replace({widget: cover, block: true}).range(first.from, last.to),
			)
			return
		}
		const target = conflict.target ? conflict.target.split("\n") : []
		const source = conflict.source ? conflict.source.split("\n") : []
		const prefer = conflict.state === "source" ? [source, target] : [target, source]
		for (let number = first.number; number <= last.number; number++) {
			const line = doc.line(number)
			const side = prefer.find(lines => takeLine(lines, line.text))
			if (!side) continue
			const className = side === target ? "cm-conflictTarget" : "cm-conflictSource"
			ranges.push(Decoration.line({class: className}).range(line.from))
		}
	})
	return Decoration.set(ranges, true)
}

// Whether `lines` has `text`, using that copy up so it's matched once.
function takeLine(lines: string[], text: string): boolean {
	const at = lines.indexOf(text)
	if (at < 0) return false
	lines.splice(at, 1)
	return true
}

// The row heading a conflict: each option, to preview by hovering and take
// by clicking.
class ConflictChips extends WidgetType {
	constructor(
		readonly index: number,
		readonly conflict: TextConflict,
		readonly shown: ConflictsShown,
		readonly previewed: ConflictOption | null,
	) {
		super()
	}
	eq(other: ConflictChips) {
		return (
			other.index === this.index &&
			other.previewed === this.previewed &&
			JSON.stringify(other.conflict) === JSON.stringify(this.conflict) &&
			other.shown.sides?.source === this.shown.sides?.source &&
			other.shown.sides?.target === this.shown.sides?.target &&
			other.shown.take === this.shown.take
		)
	}
	toDOM(view: EditorView) {
		const {conflict, shown, index} = this
		const row = document.createElement("div")
		row.className = "cm-conflictChips"
		if (conflict.state === "open" && !this.previewed) row.classList.add("cm-conflictOpen")
		const options: {option: ConflictOption; name: string; colours: string[]}[] = [
			{option: "target", name: shown.sides?.target ?? "target", colours: [TARGET]},
			{option: "source", name: shown.sides?.source ?? "source", colours: [SOURCE]},
			{option: "both", name: "both", colours: [TARGET, SOURCE]},
		]
		for (const {option, name, colours} of options) {
			const chip = document.createElement("button")
			chip.type = "button"
			chip.className = "cm-conflictChip"
			chip.style.setProperty("--chip-colour", colours[0])
			chip.setAttribute("aria-pressed", String(conflict.state === option))
			if (this.previewed === option) chip.dataset.previewed = ""
			for (const colour of colours) {
				const ring = document.createElement("span")
				ring.className = "cm-conflictRing"
				ring.style.setProperty("--ring-colour", colour)
				chip.append(ring)
			}
			chip.append(name)
			chip.title = conflict[option] || "(nothing)"
			// Keep the editor's selection where it is.
			chip.addEventListener("mousedown", event => event.preventDefault())
			chip.addEventListener("mouseenter", () => view.dispatch({effects: setPreview.of({index, option})}))
			chip.addEventListener("mouseleave", () => view.dispatch({effects: setPreview.of(null)}))
			chip.addEventListener("click", () => {
				view.dispatch({effects: setPreview.of(null)})
				shown.take?.(conflict, option)
			})
			row.append(chip)
		}
		return row
	}
	ignoreEvent() {
		return true
	}
}

// Where an open conflict's lines are: a hatch, nothing to read.
class Hatch extends WidgetType {
	eq() {
		return true
	}
	toDOM() {
		const element = document.createElement("div")
		element.className = "cm-conflictHatch"
		return element
	}
}

// An option's lines, shown in place while it's hovered.
class PreviewLines extends WidgetType {
	constructor(readonly lines: {text: string; colour: string}[]) {
		super()
	}
	eq(other: PreviewLines) {
		return JSON.stringify(other.lines) === JSON.stringify(this.lines)
	}
	toDOM() {
		const element = document.createElement("div")
		for (const line of this.lines.length ? this.lines : [{text: "", colour: NEUTRAL}]) {
			const each = document.createElement("div")
			each.className = "cm-conflictPreviewLine"
			each.style.setProperty("--line-colour", line.colour)
			each.textContent = line.text || "​"
			element.append(each)
		}
		return element
	}
}

// How a conflict went, beside its row: open, a side taken, or edited.
class StateMarker extends GutterMarker {
	constructor(readonly state: ConflictState) {
		super()
	}
	eq(other: StateMarker) {
		return other.state === this.state
	}
	toDOM() {
		return stateIcon(this.state)
	}
}

function stateIcon(state: ConflictState): HTMLElement {
	const icon = document.createElement("span")
	const kind = state === "open" ? "open" : state === "edited" ? "edited" : "taken"
	icon.className = `cm-conflictIcon cm-conflictIcon-${kind}`
	icon.textContent = kind === "open" ? "⇄" : kind === "edited" ? "✎" : "✓"
	icon.title =
		kind === "open" ? "Both changed this" : kind === "edited" ? "Edited" : "Resolved"
	// Shown outside the editor too (the heading), where the theme doesn't reach.
	Object.assign(icon.style, {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: "16px",
		height: "16px",
		borderRadius: "50%",
		fontSize: "10px",
		lineHeight: "1",
		boxSizing: "border-box",
		...(kind === "open"
			? {background: CONFLICT, color: "white"}
			: {border: `1.5px solid ${kind === "edited" ? NEUTRAL : INSERTED}`, color: kind === "edited" ? NEUTRAL : INSERTED}),
	})
	return icon
}

// --- Before's side of them: the target's lines, then the source's ---

const beforeField = StateField.define<{marks: DecorationSet; ranges: {from: number; to: number}[]}>({
	create: () => ({marks: Decoration.none, ranges: []}),
	update(value, transaction) {
		let next = transaction.docChanged
			? {
					marks: value.marks.map(transaction.changes),
					ranges: value.ranges.map(range => ({
						from: transaction.changes.mapPos(range.from, -1),
						to: transaction.changes.mapPos(range.to, 1),
					})),
				}
			: value
		for (const effect of transaction.effects)
			if (effect.is(setConflicts))
				next = {
					marks: beforeMarksFor(transaction.state.doc, effect.value),
					ranges: effect.value.conflicts.flatMap(conflict => (conflict.before ? [conflict.before] : [])),
				}
		return next
	},
	provide: field => EditorView.decorations.from(field, value => value.marks),
})

/** Before's conflicts: the target's lines labelled, the source's after them. */
const beforeMarks: Extension = [
	beforeField,
	touchedBy.of(state => {
		const ranges = state.field(beforeField, false)?.ranges ?? []
		return ranges.length ? rangeLines(state.doc, ranges) : NONE
	}),
	CONFLICT_THEME,
]

function beforeMarksFor(doc: Text, shown: ConflictsShown): DecorationSet {
	const ranges: Range<Decoration>[] = []
	for (const conflict of shown.conflicts) {
		if (!conflict.before) continue
		const {first, last} = conflictLines(doc, conflict.before)
		const hasTarget = !!conflict.target
		if (hasTarget) {
			for (let number = first.number; number <= last.number; number++)
				ranges.push(Decoration.line({class: "cm-conflictTarget"}).range(doc.line(number).from))
			ranges.push(
				Decoration.widget({widget: new SideLabel(shown.sides?.target ?? "target", TARGET), side: -1}).range(
					first.from,
				),
			)
		}
		const source = conflict.source ? conflict.source.split("\n") : []
		if (!source.length) continue
		ranges.push(
			Decoration.widget({
				widget: new SourceLines(source, shown.sides?.source ?? "source"),
				block: true,
				side: hasTarget ? 1 : -1,
			}).range(hasTarget ? last.to : first.from),
		)
	}
	return Decoration.set(ranges, true)
}

// A side's name, at the end of the line it heads.
class SideLabel extends WidgetType {
	constructor(
		readonly name: string,
		readonly colour: string,
	) {
		super()
	}
	eq(other: SideLabel) {
		return other.name === this.name && other.colour === this.colour
	}
	toDOM() {
		const label = document.createElement("span")
		label.className = "cm-conflictLabel"
		label.style.setProperty("--label-colour", this.colour)
		label.textContent = this.name
		return label
	}
}

// The source's lines, in before, after the target's.
class SourceLines extends WidgetType {
	constructor(
		readonly lines: string[],
		readonly name: string,
	) {
		super()
	}
	eq(other: SourceLines) {
		return other.name === this.name && other.lines.join("\n") === this.lines.join("\n")
	}
	toDOM() {
		const element = document.createElement("div")
		this.lines.forEach((text, i) => {
			const line = document.createElement("div")
			line.className = "cm-conflictBefore"
			if (i === 0) line.append(new SideLabel(this.name, SOURCE).toDOM())
			line.append(text || "​")
			element.append(line)
		})
		return element
	}
}

// The view's conflicts, kept to what the compare says.
function followConflicts(view: EditorView, compare: Accessor<DraftCompare | undefined>) {
	createEffect(
		on(
			() => {
				const current = compare()
				return {conflicts: current?.conflicts ?? [], sides: current?.sides, take: current?.take}
			},
			shown => view.dispatch({effects: setConflicts.of(shown)}),
		),
	)
}

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

const sameLines = (a: readonly number[], b: readonly number[]) =>
	a === b || (a.length === b.length && a.every((line, i) => line === b[i]))

// Side by side, a merge folds with this rather than the merge view's own
// folding, which knows only what differs: each side keeps what changed open,
// from the merge view's chunks, and its conflicts.
function chunkLines(state: EditorState): readonly number[] {
	const found = getChunks(state)
	if (!found) return NONE
	const lines = new Set<number>()
	for (const chunk of found.chunks) {
		const [from, to] = found.side === "a" ? [chunk.fromA, chunk.toA] : [chunk.fromB, chunk.toB]
		const first = state.doc.lineAt(Math.min(from, state.doc.length)).number
		const last = state.doc.lineAt(Math.min(Math.max(from, to - 1), state.doc.length)).number
		for (let line = first; line <= last; line++) lines.add(line)
	}
	return [...lines].sort((x, y) => x - y)
}

const foldBeside = (): Extension => [collapseUnchanged, touchedBy.of(chunkLines)]

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
			if (sameLines(touched, value.touched) && unfolded === value.unfolded) return value
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
