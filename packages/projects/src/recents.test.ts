import type {AutomergeUrl, DocHandle} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {describe, expect, it, vi} from "vitest"
import {addToRecents, groupRecents, recentsOf, removeFromRecents, setPinned} from "./recents.ts"

const A = "automerge:3regSr3818zmNnyXN5EobkuGtGhB" as AutomergeUrl
const B = "automerge:41DCUsb2mbtrzLAwAbxbMyF8zDfF" as AutomergeUrl

function handle(docs: FolderDoc["docs"]) {
	const doc: FolderDoc = {title: "Recent projects", docs}
	return {
		doc: () => doc,
		change: vi.fn((fn: (doc: FolderDoc) => void) => fn(doc)),
	} as unknown as DocHandle<FolderDoc> & {change: ReturnType<typeof vi.fn>}
}

const entry = (name: string, url: AutomergeUrl, firstOpened?: number, pinned?: boolean) => ({
	name,
	type: "folder",
	url,
	...(firstOpened === undefined ? {} : {firstOpened}),
	...(pinned ? {pinned} : {}),
})

const NOW = new Date(2026, 10, 16, 12, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

describe("addToRecents", () => {
	it("moves a project to the top, once", () => {
		const recents = handle([entry("B", B, 1), entry("A", A, 2), entry("A", A, 3)])
		addToRecents(recents, A, "A", "folder", NOW)
		expect(recents.doc()!.docs).toEqual([entry("A", A, 2), entry("B", B, 1)])
	})

	it("remembers when it was first opened, and keeps it", () => {
		const recents = handle([entry("B", B, 1)])
		addToRecents(recents, A, "A", "folder", NOW)
		addToRecents(recents, B, "B", "folder", NOW)
		addToRecents(recents, A, "A", "folder", NOW + DAY)
		expect(recents.doc()!.docs).toEqual([entry("A", A, NOW), entry("B", B, 1)])
	})

	it("keeps a pin", () => {
		const recents = handle([entry("B", B, 1), entry("A", A, 2, true)])
		addToRecents(recents, A, "A", "folder", NOW)
		expect(recents.doc()!.docs).toEqual([entry("A", A, 2, true), entry("B", B, 1)])
	})

	it("refreshes the name of a project that was renamed", () => {
		const recents = handle([entry("Old name", A, 1)])
		addToRecents(recents, A, "New name", "folder", NOW)
		expect(recents.doc()!.docs).toEqual([entry("New name", A, 1)])
	})

	it("records a root's datatype", () => {
		const recents = handle([entry("A", A, 1)])
		addToRecents(recents, B, "Notes", "markdown", NOW)
		expect(recents.doc()!.docs).toEqual([
			{name: "Notes", type: "markdown", url: B, firstOpened: NOW},
			entry("A", A, 1),
		])
	})

	it("leaves the list alone when the project is already on top", () => {
		const recents = handle([entry("A", A, 1), entry("B", B, 2)])
		addToRecents(recents, A, "A", "folder", NOW)
		expect(recents.change).not.toHaveBeenCalled()
	})
})

describe("setPinned", () => {
	it("pins and unpins", () => {
		const recents = handle([entry("A", A, 1), entry("B", B, 2)])
		setPinned(recents, B, true)
		expect(recentsOf(recents.doc()).map(recent => recent.pinned)).toEqual([false, true])
		setPinned(recents, B, false)
		expect(recents.doc()!.docs).toEqual([entry("A", A, 1), entry("B", B, 2)])
	})
})

describe("groupRecents", () => {
	it("puts what's pinned first, then the rest by when it was first opened", () => {
		const at = (days: number) => NOW - days * DAY
		const C = "automerge:3Dgi4umWwcDVUXhyLYWLeoRRhzWh" as AutomergeUrl
		const D = "automerge:4RwwSmVeLXRPz6qGaComRg2mo4Mr" as AutomergeUrl
		const E = "automerge:3ZT3EMbMQuKbbPtrryLH8vvuPhW5" as AutomergeUrl
		const list = recentsOf({
			docs: [
				entry("Old", A, at(40)),
				entry("Undated", B),
				entry("Pinned", C, at(90), true),
				entry("Now", D, at(0)),
				entry("Yesterday", E, at(1)),
			],
		})
		const groups = groupRecents(list, new Date(NOW))
		expect(groups.map(group => [group.label, group.recents.map(recent => recent.name)])).toEqual([
			["Pinned", ["Pinned"]],
			["Today", ["Now"]],
			["Yesterday", ["Yesterday"]],
			["Older", ["Old", "Undated"]],
		])
	})
})

describe("removeFromRecents", () => {
	it("takes every entry for the project off the list", () => {
		const recents = handle([entry("A", A, 1), entry("B", B, 2), entry("A", A, 3)])
		removeFromRecents(recents, A)
		expect(recents.doc()!.docs).toEqual([entry("B", B, 2)])
	})
})
