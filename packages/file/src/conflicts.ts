// Where a text file's merge needs a person: lines the source and the target
// both changed since the version they share. Automerge keeps both sides'
// edits there, side by side, which is rarely what either meant; identical
// edits included, since it keeps both copies of those too. Registered as the
// file datatype's `patchwork:merge-conflicts` plugin.

import {Automerge} from "@automerge/automerge-repo/slim"
import {diff} from "@codemirror/merge"
import {commonAncestor} from "./components/ancestor"

type Doc = Automerge.Doc<unknown>

// As the drafts package's overlay provider reads it.
type Conflict = {
	at: {path: string[]; from: string; to: string}
	source: string
	target: string
	/** the target's lines, then the source's */
	both: string
}

const PATH = ["content"]

// A change on one side, in the shared text's offsets: `from` the start of
// its first line, `to` the end of its last (the newline, or the text's end).
type Hunk = {side: "source" | "target"; from: number; to: number; delta: number}

/**
 * The conflicts between the source's and the target's text, each placed
 * strictly between the characters just outside its lines, so it reads the
 * same in auto and in the merge however its inside is rewritten.
 */
export function findTextConflicts(versions: {source: Doc; target: Doc; auto: Doc}): Conflict[] {
	const source = textOf(versions.source)
	const target = textOf(versions.target)
	if (source === undefined || target === undefined) return []
	const heads = commonAncestor(versions.source, versions.target)
	if (!heads.length) return []
	const base = Automerge.view(versions.auto, heads)
	const shared = textOf(base) ?? ""

	const hunks = [...hunksOf(shared, source, "source"), ...hunksOf(shared, target, "target")].sort(
		(a, b) => a.from - b.from || a.to - b.to,
	)
	const conflicts: Conflict[] = []
	for (const group of overlapping(hunks)) {
		if (!group.some(hunk => hunk.side === "source") || !group.some(hunk => hunk.side === "target")) continue
		const from = Math.min(...group.map(hunk => hunk.from))
		const to = Math.max(...group.map(hunk => hunk.to))
		conflicts.push({
			at: {
				path: PATH,
				from: from === 0 ? "start" : Automerge.getCursor(base, PATH, from - 1),
				to: to >= shared.length ? "end" : Automerge.getCursor(base, PATH, to),
			},
			...sides(slice(source, hunks, "source", from, to), slice(target, hunks, "target", from, to)),
		})
	}
	return conflicts
}

// Each side's lines, and both: the target's, then the source's.
function sides(source: string, target: string) {
	const both = !target ? source : !source ? target : `${target}\n${source}`
	return {source, target, both}
}

// One side's changes, each widened to the whole lines it touches.
function hunksOf(shared: string, text: string, side: Hunk["side"]): Hunk[] {
	return diff(shared, text).map(change => {
		const last = change.toA > change.fromA ? change.toA - 1 : change.fromA
		return {
			side,
			from: lineStart(shared, change.fromA),
			to: lineEnd(shared, last),
			delta: change.toB - change.fromB - (change.toA - change.fromA),
		}
	})
}

// Runs of hunks whose lines meet or overlap, in order.
function overlapping(hunks: Hunk[]): Hunk[][] {
	const groups: Hunk[][] = []
	let end = -Infinity
	for (const hunk of hunks) {
		if (groups.length && hunk.from <= end) {
			groups[groups.length - 1].push(hunk)
			end = Math.max(end, hunk.to)
		} else {
			groups.push([hunk])
			end = hunk.to
		}
	}
	return groups
}

// What one side has where the shared text has `from` to `to`: offsets moved
// by that side's changes before them, and the end by those inside too.
function slice(text: string, hunks: Hunk[], side: Hunk["side"], from: number, to: number): string {
	let before = 0
	let inside = 0
	for (const hunk of hunks) {
		if (hunk.side !== side) continue
		if (hunk.to < from) before += hunk.delta
		else if (hunk.from <= to) inside += hunk.delta
	}
	return text.slice(from + before, to + before + inside)
}

function lineStart(text: string, at: number): number {
	return text.lastIndexOf("\n", at - 1) + 1
}

function lineEnd(text: string, at: number): number {
	const next = text.indexOf("\n", at)
	return next === -1 ? text.length : next
}

function textOf(doc: unknown): string | undefined {
	const content = (doc as {content?: unknown} | undefined)?.content
	return typeof content === "string" ? content : undefined
}
