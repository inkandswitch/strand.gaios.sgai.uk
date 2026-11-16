import {describe, expect, it} from "vitest"
import {EditorState} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {diffEditor, follow, modifiedLines, splicesOf} from "./draft-diff"

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

describe("side by side", () => {
	it("marks lines changed on both sides, but not ones only added", () => {
		const editor = diffEditor({
			doc: "one\nTWO\nthree\nfour\nadded",
			extensions: [],
			besideExtensions: [],
			beside: true,
			compare: () => ({
				mode: "side-by-side",
				original: "one\ntwo\nthree\nfour",
				collapsed: false,
				editable: false,
				names: null,
				merging: false,
			}),
		})
		const [ours, theirs] = editor.views
		expect(modifiedLines(ours.state)).toEqual([2])
		expect(modifiedLines(theirs.state)).toEqual([2])
		editor.destroy()
	})
})
