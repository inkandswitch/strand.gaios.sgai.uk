import {describe, expect, it} from "vitest"
import * as A from "@automerge/automerge"
import {commonAncestor} from "./ancestor"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"

type Text = {content: string}

const start = (content: string) =>
	A.change(A.init<Text>(), doc => {
		doc.content = content
	})

const splice = (doc: A.Doc<Text>, index: number, remove: number, insert = "") =>
	A.change(doc, d => A.splice(d, ["content"], index, remove, insert))

const textAt = (doc: A.Doc<Text>, heads: A.Heads) =>
	fileText(A.view(doc, heads) as unknown as FileDoc)

describe("commonAncestor", () => {
	it("is where two forks parted", () => {
		const base = splice(start("one two three"), 0, 0, "zero ")
		let ours = A.clone(base)
		let theirs = A.clone(base)
		ours = splice(ours, 0, 4, "ZERO")
		theirs = splice(theirs, theirs.content.length, 0, " four")
		theirs = splice(theirs, 5, 3, "uno")
		const heads = commonAncestor(ours, theirs)
		expect(textAt(theirs, heads)).toBe("zero one two three")
		expect(textAt(ours, heads)).toBe("zero one two three")
		expect(heads.sort()).toEqual(A.getHeads(base).sort())
		expect(commonAncestor(theirs, ours).sort()).toEqual(A.getHeads(base).sort())
	})

	it("is the one behind, when the other is ahead of it", () => {
		const base = start("abc")
		const ahead = splice(A.clone(base), 3, 0, "def")
		expect(commonAncestor(ahead, base)).toEqual(A.getHeads(base))
		expect(commonAncestor(base, ahead)).toEqual(A.getHeads(base))
	})

	it("is either, when they're the same", () => {
		const doc = start("same")
		expect(commonAncestor(doc, A.clone(doc))).toEqual(A.getHeads(doc))
	})

	it("takes in what was merged across, with more heads than it needs", () => {
		const base = start("a")
		let ours = splice(A.clone(base), 1, 0, "b")
		const shared = A.getHeads(ours)
		let theirs = splice(A.clone(base), 0, 0, "z")
		// They take ours' change in, and go on.
		theirs = A.merge(theirs, ours)
		theirs = splice(theirs, theirs.content.length, 0, "!")
		ours = splice(ours, 0, 0, "<")
		const heads = commonAncestor(ours, theirs)
		// Ours' change, and where theirs started from, which it came after
		// too: redundant, but read just the same.
		expect(new Set(heads)).toEqual(new Set([...shared, ...A.getHeads(base)]))
		expect(textAt(theirs, heads)).toBe("ab")
		expect(textAt(ours, heads)).toBe("ab")
	})

	it("is nothing when they share nothing", () => {
		expect(commonAncestor(start("a"), start("b"))).toEqual([])
		expect(textAt(start("b"), [])).toBe("")
	})
})
