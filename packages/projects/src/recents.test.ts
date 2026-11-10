import type {AutomergeUrl, DocHandle} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {describe, expect, it, vi} from "vitest"
import {addToRecents, removeFromRecents} from "./recents.ts"

const A = "automerge:3regSr3818zmNnyXN5EobkuGtGhB" as AutomergeUrl
const B = "automerge:41DCUsb2mbtrzLAwAbxbMyF8zDfF" as AutomergeUrl

function handle(docs: FolderDoc["docs"]) {
	const doc: FolderDoc = {title: "Recent projects", docs}
	return {
		doc: () => doc,
		change: vi.fn((fn: (doc: FolderDoc) => void) => fn(doc)),
	} as unknown as DocHandle<FolderDoc> & {change: ReturnType<typeof vi.fn>}
}

const entry = (name: string, url: AutomergeUrl) => ({name, type: "folder", url})

describe("addToRecents", () => {
	it("moves a project to the top, once", () => {
		const recents = handle([entry("B", B), entry("A", A), entry("A", A)])
		addToRecents(recents, A, "A")
		expect(recents.doc()!.docs).toEqual([entry("A", A), entry("B", B)])
	})

	it("refreshes the name of a project that was renamed", () => {
		const recents = handle([entry("Old name", A)])
		addToRecents(recents, A, "New name")
		expect(recents.doc()!.docs).toEqual([entry("New name", A)])
	})

	it("leaves the list alone when the project is already on top", () => {
		const recents = handle([entry("A", A), entry("B", B)])
		addToRecents(recents, A, "A")
		expect(recents.change).not.toHaveBeenCalled()
	})
})

describe("removeFromRecents", () => {
	it("takes every entry for the project off the list", () => {
		const recents = handle([entry("A", A), entry("B", B), entry("A", A)])
		removeFromRecents(recents, A)
		expect(recents.doc()!.docs).toEqual([entry("B", B)])
	})
})
