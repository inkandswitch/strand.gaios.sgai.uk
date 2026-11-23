import {describe, expect, it} from "vitest"
import {EditorState, Text} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {
	combinedRanges,
	afterMarks,
	diffEditor,
	follow,
	modifiedLines,
	splicesOf,
	versionRanges,
	type DraftCompare,
	type TextConflict,
} from "./draft-diff"

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
	names: null,
	merging: false,
	conflicts: [],
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

describe("a merge's conflicts, in after", () => {
	const doc = Text.of(["one", "2", "TWO", "four"])
	const conflict = (state: TextConflict["state"]) => ({
		from: doc.line(2).from,
		to: doc.line(3).to,
		source: "TWO",
		target: "2",
		both: "2\nTWO",
		state,
	})
	const found = (marks: ReturnType<typeof afterMarks>) => {
		const out: string[] = []
		marks.between(0, doc.length, (at, to, mark) => {
			const kind = mark.spec.widget?.constructor.name ?? mark.spec.class
			out.push(`${doc.lineAt(at).number}${to > at ? `-${doc.lineAt(to).number}` : ""} ${kind}`)
		})
		return out
	}

	it("hides an open conflict's lines under a hatch, beneath its options", () => {
		expect(found(afterMarks(doc, {conflicts: [conflict("open")]}, null))).toEqual([
			"2 ConflictChips",
			"2-3 Hatch",
		])
	})

	it("shows the option hovered in place of the lines", () => {
		const marks = afterMarks(doc, {conflicts: [conflict("open")]}, {index: 0, option: "both"})
		expect(found(marks)).toEqual(["2 ConflictChips", "2-3 PreviewLines"])
	})

	it("colours each taken line by the side it came from", () => {
		expect(found(afterMarks(doc, {conflicts: [conflict("both")]}, null))).toEqual([
			"2 ConflictChips",
			"2 cm-conflictTarget",
			"3 cm-conflictSource",
		])
	})

	it("drops the colour of a line that was edited", () => {
		const edited = Text.of(["one", "2", "WINTER", "four"])
		const marks = afterMarks(edited, {conflicts: [{...conflict("edited"), to: edited.line(3).to}]}, null)
		const out: string[] = []
		marks.between(0, edited.length, (at, _to, mark) => {
			out.push(`${edited.lineAt(at).number} ${mark.spec.widget?.constructor.name ?? mark.spec.class}`)
		})
		expect(out).toEqual(["2 ConflictChips", "2 cm-conflictTarget"])
	})
})

describe("a merge's conflicts, folding", () => {
	it("keep a conflict open when it's resolved to what before has", () => {
		const lines = Array.from({length: 30}, (_, i) => `line-${String(i + 1).padStart(2, "0")}`)
		const text = lines.join("\n")
		const doc = Text.of(lines)
		const conflict: TextConflict = {
			from: doc.line(15).from,
			to: doc.line(15).to,
			source: "SOURCE",
			target: "line-15",
			both: "line-15\nSOURCE",
			state: "target",
		}
		const editor = diffEditor({
			doc: text,
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => ({...comparing("stacked", text, text), collapsed: true, merging: true, conflicts: [conflict]}),
		})
		const shown = editor.view.contentDOM.textContent ?? ""
		expect(shown).toContain("line-15")
		expect(shown).not.toContain("line-05")
		editor.destroy()

		// Without it, that line reads as unchanged and folds away.
		const plain = diffEditor({
			doc: text,
			extensions: [],
			besideExtensions: [],
			beside: false,
			compare: () => ({...comparing("stacked", text, text), collapsed: true, merging: true, conflicts: []}),
		})
		expect(plain.view.contentDOM.textContent ?? "").not.toContain("line-15")
		plain.destroy()
	})
})

