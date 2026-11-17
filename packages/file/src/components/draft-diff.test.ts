import {describe, expect, it} from "vitest"
import {EditorState, Text} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {combinedRanges, diffEditor, follow, modifiedLines, splicesOf, type DraftCompare} from "./draft-diff"

// Makes the splices, one after another, to `text`.
const apply = (text: string, splices: ReturnType<typeof splicesOf>) =>
	splices.reduce(
		(at, {index, remove, insert}) => at.slice(0, index) + insert + at.slice(index + remove),
		text,
	)

describe("splicesOf", () => {
	it("turns several changes at once into splices made one after another", () => {
		const state = EditorState.create({doc: "one two three"})
		const changes = state.changes([
			{from: 0, to: 3, insert: "uno"},
			{from: 4, to: 7, insert: "zwei!"},
			{from: 13, insert: " vier"},
		])
		const splices = splicesOf(changes)
		expect(splices.every(each => each.path.join() === "content")).toBe(true)
		expect(apply("one two three", splices)).toBe(changes.apply(state.doc).toString())
	})

	it("keeps a deletion a deletion", () => {
		const state = EditorState.create({doc: "abcdef"})
		expect(splicesOf(state.changes({from: 1, to: 4}))).toEqual([
			{path: ["content"], index: 1, remove: 3, insert: ""},
		])
	})
})

describe("follow", () => {
	const editor = (doc: string, cursor: number) =>
		new EditorView({state: EditorState.create({doc, selection: {anchor: cursor}})})

	it("changes only what differs, so the cursor stays put around it", () => {
		const view = editor("hello world, how are you", 22)
		follow(view, "hello there world, how are you")
		expect(view.state.doc.toString()).toBe("hello there world, how are you")
		expect(view.state.selection.main.head).toBe(28)
		view.destroy()
	})

	it("doesn't split a surrogate pair", () => {
		const view = editor("a😀b", 0)
		follow(view, "a😃b")
		expect(view.state.doc.toString()).toBe("a😃b")
		view.destroy()
	})

	it("does nothing when the text is already the same", () => {
		const view = editor("same", 2)
		const before = view.state
		follow(view, "same")
		expect(view.state).toBe(before)
		view.destroy()
	})
})

const comparing = (mode: DraftCompare["mode"], base: string, original: string): DraftCompare => ({
	mode,
	original,
	base,
	collapsed: false,
	editable: false,
	names: null,
	merging: false,
})

const ghosts = (view: EditorView, kind: string) =>
	[...view.dom.querySelectorAll(`.${kind}`)].map(each => each.textContent)

describe("side by side", () => {
	it("marks on each side what its draft changed since they parted", () => {
		const base = "one\ntwo\nthree\nfour\nfive"
		const editor = diffEditor({
			doc: "one\nTWO\nthree\nfour\nfive\nadded",
			extensions: [],
			besideExtensions: [],
			beside: true,
			compare: () => comparing("side-by-side", base, "one\ntwo\nthree\nFOUR\nfive"),
		})
		const [ours, theirs] = editor.views
		expect(modifiedLines(ours.state)).toEqual([2])
		expect(modifiedLines(theirs.state)).toEqual([4])
		expect(ours.dom.querySelectorAll(".cm-line.cm-insertedLine")).toHaveLength(1)
		expect(theirs.dom.querySelectorAll(".cm-line.cm-insertedLine")).toHaveLength(0)
		editor.destroy()
	})

	it("marks nothing on the side whose draft changed nothing", () => {
		const base = "one\ntwo\nthree"
		const editor = diffEditor({
			doc: "one\nthree",
			extensions: [],
			besideExtensions: [],
			beside: true,
			compare: () => comparing("side-by-side", base, base),
		})
		const [ours, theirs] = editor.views
		expect(ghosts(ours, "cm-deletedGhost")).toEqual(["two"])
		expect(theirs.dom.querySelectorAll(".cm-deletedGhost, .cm-line.cm-insertedLine, .cm-line.cm-modifiedLine")).toHaveLength(0)
		editor.destroy()
	})
})

describe("stacked", () => {
	it("marks what this draft changed since they parted", () => {
		const editor = diffEditor({
			doc: "one\nTWO\nthree",
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => comparing("stacked", "one\ntwo\nthree", "one\ntwo\nthree\nfour"),
		})
		expect(modifiedLines(editor.view.state)).toEqual([2])
		expect(editor.view.state.readOnly).toBe(false)
		editor.destroy()
	})
})

describe("combined", () => {
	it("marks both drafts' changes since they parted, in this draft's text", () => {
		const editor = diffEditor({
			doc: "one TWO three",
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => comparing("inline", "one two three", "two three four"),
		})
		const view = editor.view
		expect(view.state.doc.toString()).toBe("one TWO three")
		expect(view.state.readOnly).toBe(true)
		expect(ghosts(view, "cm-oursInserted")).toEqual(["TWO"])
		expect(ghosts(view, "cm-oursDeleted")).toEqual(["two"])
		expect(ghosts(view, "cm-theirsDeleted")).toEqual(["one "])
		expect(ghosts(view, "cm-theirsInserted")).toEqual([" four"])
		editor.destroy()
	})

	it("puts the other draft's changes where they fall in this draft's text", () => {
		const ours = Text.of(["added", "a b c"])
		const ranges = combinedRanges("a b c", ours, "a b c d")
		const theirs = ranges.find(
			each => (each.value.spec.widget as {className?: string})?.className === "cm-theirsInserted",
		)
		expect(theirs?.from).toBe(ours.length)
	})
})
