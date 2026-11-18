import {describe, expect, it} from "vitest"
import {EditorState, Text} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {combinedRanges, diffEditor, follow, modifiedLines, splicesOf, versionRanges, type DraftCompare} from "./draft-diff"

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

const lineClasses = (view: EditorView, kind: string) =>
	[...view.dom.querySelectorAll(`.cm-line.${kind}`)].map(each => each.textContent)

describe("side by side", () => {
	it("marks lines that differ yellow on both sides, nothing struck out", () => {
		const base = "one\ntwo\nthree"
		const editor = diffEditor({
			doc: "one\nTWO\nthree",
			extensions: [],
			besideExtensions: [],
			beside: true,
			compare: () => comparing("side-by-side", base, base),
		})
		const [ours, theirs] = editor.views
		expect(lineClasses(ours, "cm-differsLine")).toEqual(["TWO"])
		expect(lineClasses(theirs, "cm-differsLine")).toEqual(["two"])
		expect(ours.dom.querySelectorAll(".cm-ghost")).toHaveLength(0)
		editor.destroy()
	})

	it("marks lines only one side has: added by its draft, or removed by the other's", () => {
		const base = "one\ntwo\nthree"
		const editor = diffEditor({
			doc: "one\nthree\nmine",
			extensions: [],
			besideExtensions: [],
			beside: true,
			compare: () => comparing("side-by-side", base, base),
		})
		const [ours, theirs] = editor.views
		expect(lineClasses(ours, "cm-addedLine")).toEqual(["mine"])
		expect(lineClasses(theirs, "cm-removedLine")).toEqual(["two"])
		expect(theirs.dom.querySelectorAll(".cm-line.cm-addedLine, .cm-line.cm-differsLine")).toHaveLength(0)
		editor.destroy()
	})
})

describe("versionRanges", () => {
	it("tells added from removed by the ancestor", () => {
		const doc = Text.of(["a", "new", "b"])
		const kinds = versionRanges("a\nb", doc, "a\nb").map(each => each.value.spec.class)
		expect(kinds).toEqual(["cm-addedLine"])
		const kept = versionRanges("a\nold\nb", Text.of(["a", "old", "b"]), "a\nb").map(each => each.value.spec.class)
		expect(kept).toEqual(["cm-removedLine"])
	})
})

describe("merging", () => {
	it("marks a combined merge as added and removed, not by draft", () => {
		const before = "one\ntwo"
		const editor = diffEditor({
			doc: "one\nTWO",
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => ({...comparing("inline", before, before), merging: true}),
		})
		expect(editor.view.dom.classList.contains("cm-diff-merge")).toBe(true)
		editor.destroy()
	})

	it("doesn't while comparing", () => {
		const editor = diffEditor({
			doc: "one\nTWO",
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => comparing("inline", "one\ntwo", "one\ntwo"),
		})
		expect(editor.view.dom.classList.contains("cm-diff-merge")).toBe(false)
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
	it("shows both versions where they differ, in their drafts' colours, nothing struck out", () => {
		const editor = diffEditor({
			doc: "one\nTWO\nthree",
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => comparing("inline", "one\ntwo\nthree", "one\nTwo\nthree"),
		})
		const view = editor.view
		expect(view.state.readOnly).toBe(true)
		expect(lineClasses(view, "cm-oursLine")).toEqual(["TWO"])
		expect(ghosts(view, "cm-theirsLines")).toEqual(["Two"])
		expect(view.dom.querySelector(".cm-oursDeleted, .cm-theirsDeleted")).toBeNull()
		editor.destroy()
	})

	it("puts lines only theirs has where they'd be", () => {
		const ours = Text.of(["a", "c"])
		const ranges = combinedRanges(ours, "a\nb\nc")
		expect(ranges).toHaveLength(1)
		expect(ranges[0].from).toBe(2)
		expect(ranges[0].value.spec.side).toBe(-1)
	})

	it("puts lines only theirs has at the end after the last line", () => {
		const ours = Text.of(["a", "b"])
		const ranges = combinedRanges(ours, "a\nb\nc")
		expect(ranges.map(each => [each.from, each.value.spec.side])).toEqual([[ours.length, 1]])
	})
})
