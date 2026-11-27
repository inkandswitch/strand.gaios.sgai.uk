import {describe, expect, it} from "vitest"
import * as A from "@automerge/automerge"
import {findTextConflicts} from "./conflicts"

type Text = {"@patchwork": {type: "file"}; content: string}

const start = (content: string) =>
	A.change(A.init<Text>(), doc => {
		doc["@patchwork"] = {type: "file"}
		doc.content = content
	})

// A copy with an actor of its own, as another device would have.
const fork = (doc: A.Doc<Text>) => A.load<Text>(A.save(doc))

const replace = (doc: A.Doc<Text>, find: string, insert: string) =>
	A.change(fork(doc), d => A.splice(d, ["content"], d.content.indexOf(find), find.length, insert))

const versions = (source: A.Doc<Text>, target: A.Doc<Text>) => ({
	source,
	target,
	auto: A.merge(A.clone(target), source),
})

// The text of a conflict's place in `doc`: strictly between its ends.
const textAt = (doc: A.Doc<Text>, at: {from: string; to: string}) => {
	const from = at.from === "start" ? 0 : A.getCursorPosition(doc, ["content"], at.from) + 1
	const to = at.to === "end" ? doc.content.length : A.getCursorPosition(doc, ["content"], at.to)
	return doc.content.slice(from, to)
}

describe("text conflicts", () => {
	const base = start("one\ntwo\nthree\n")

	it("is a line both sides changed, with each side's lines", () => {
		const v = versions(replace(base, "two", "TWO"), replace(base, "two", "2"))
		const [conflict, ...rest] = findTextConflicts(v)
		expect(rest).toEqual([])
		expect(conflict).toMatchObject({source: "TWO", target: "2", both: "2\nTWO"})
		expect([...textAt(v.auto, conflict.at)].sort().join("")).toBe([..."TWO2"].sort().join(""))
	})

	it("isn't one where the sides changed different lines", () => {
		expect(findTextConflicts(versions(replace(base, "one", "ONE"), replace(base, "three", "3")))).toEqual([])
	})

	it("is one where both sides made the same change, since both copies are kept", () => {
		const [conflict] = findTextConflicts(versions(replace(base, "two", "2"), replace(base, "two", "2")))
		expect(conflict).toMatchObject({source: "2", target: "2"})
	})

	it("reads each side's lines past what it changed earlier on", () => {
		const source = replace(replace(base, "one", "zero\none"), "two", "TWO")
		const [conflict] = findTextConflicts(versions(source, replace(base, "two", "2")))
		expect(conflict).toMatchObject({source: "TWO", target: "2"})
	})

	it("reaches the start of the text", () => {
		const [conflict] = findTextConflicts(versions(replace(base, "one", "ONE"), replace(base, "one", "1")))
		expect(conflict.at.from).toBe("start")
		expect(conflict).toMatchObject({source: "ONE", target: "1"})
	})

	it("is only the lines both changed, where each side's edits span several", () => {
		const source = replace(base, "one\ntwo", "ONE\nTWO")
		const [conflict, ...rest] = findTextConflicts(versions(source, replace(base, "two\nthree", "2\n3")))
		expect(rest).toEqual([])
		expect(conflict).toMatchObject({source: "TWO", target: "2"})
	})

	it("takes in a line one side changed next to one both did, when one edit spans them", () => {
		const source = replace(base, "one\ntwo", "ONE TWO")
		const [conflict, ...rest] = findTextConflicts(versions(source, replace(base, "two", "2")))
		expect(rest).toEqual([])
		expect(conflict).toMatchObject({source: "ONE TWO", target: "one\n2"})
	})
})
