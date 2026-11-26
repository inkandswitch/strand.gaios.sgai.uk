import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {describe, expect, it} from "vitest"
import {documentOf, lastEdited} from "./members.ts"
import type {HistoryEntry, Member} from "./types.ts"

const ROOT = "automerge:3regSr3818zmNnyXN5EobkuGtGhB" as AutomergeUrl
const FIGURES = "automerge:41DCUsb2mbtrzLAwAbxbMyF8zDfF" as AutomergeUrl
const CHART = "automerge:3Dgi4umWwcDVUXhyLYWLeoRRhzWh" as AutomergeUrl
const CONFIG = "automerge:4RwwSmVeLXRPz6qGaComRg2mo4Mr" as AutomergeUrl

const member = (url: AutomergeUrl, parent: AutomergeUrl | null): Member => ({url, heads: [], parent})

const members = [member(ROOT, null), member(FIGURES, ROOT), member(CHART, FIGURES), member(CONFIG, ROOT)]

const entry = (id: string, time: number, changed: AutomergeUrl[]): HistoryEntry => ({
	id,
	overlay: null,
	start: time,
	time,
	actors: [],
	members: changed,
})

// newest first, as the overlay provider answers
const entries = [entry("c", 300, [CONFIG]), entry("b", 200, [CHART]), entry("a", 100, [CONFIG, CHART])]

describe("lastEdited", () => {
	it("is a member's newest entry, and a folder's newest beneath it", () => {
		const edited = lastEdited(entries, members, null)
		expect(edited.get(documentOf(CONFIG))).toBe(300)
		expect(edited.get(documentOf(CHART))).toBe(200)
		expect(edited.get(documentOf(FIGURES))).toBe(200)
		expect(edited.get(documentOf(ROOT))).toBe(300)
	})

	it("only counts entries up to a point in history", () => {
		const edited = lastEdited(entries, members, "b")
		expect(edited.get(documentOf(CONFIG))).toBe(100)
		expect(edited.get(documentOf(ROOT))).toBe(200)
	})
})
