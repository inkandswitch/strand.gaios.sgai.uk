import {beforeAll, describe, it, expect} from "vitest"
import {
	Repo,
	initSubduction,
	splice,
	type AutomergeUrl,
} from "@automerge/automerge-repo"
import {commentRanges, rangeRef, refsByThread} from "./threads"

beforeAll(() => initSubduction())

describe("rangeRef", () => {
	it("refers to the range in the file without writing to it", () => {
		const repo = new Repo()
		const handle = repo.create<any>({content: "hello, world"})
		const heads = handle.heads()
		const ref = rangeRef(handle, ["content"], 0, 5)
		expect(ref.startsWith(handle.url)).toBe(true)
		expect(handle.heads()).toEqual(heads)
	})

	it("refuses to make a range on content that isn't text", () => {
		const repo = new Repo()
		const handle = repo.create<any>({content: new Uint8Array([1, 2, 3])})
		expect(() => rangeRef(handle, ["content"], 0, 1)).toThrow()
	})
})

describe("commentRanges", () => {
	it("follows the text as it's edited and skips collapsed ranges", async () => {
		const repo = new Repo()
		const handle = repo.create<any>({content: "hello, world"})
		const target = await repo.find(rangeRef(handle, ["content"], 7, 12))

		expect(commentRanges([target])).toEqual([[7, 12]])

		handle.change((doc: any) => splice(doc, ["content"], 0, 0, "oh "))
		expect(commentRanges([target])).toEqual([[10, 15]])

		handle.change((doc: any) => splice(doc, ["content"], 10, 5, ""))
		expect(commentRanges([target])).toEqual([])
	})
})

describe("refsByThread", () => {
	it("groups the subscription's entries by thread, in order", () => {
		const [a, b, c] = ["a", "b", "c"].map((x) => `automerge:${x}` as AutomergeUrl)
		const [t1, t2] = ["t1", "t2"].map((x) => `automerge:${x}` as AutomergeUrl)
		const grouped = refsByThread([
			{targetUrl: a, threadUrl: t1},
			{targetUrl: b, threadUrl: t2},
			{targetUrl: c, threadUrl: t1},
			{targetUrl: a, threadUrl: t1},
		])
		expect([...grouped]).toEqual([
			[t1, [a, c]],
			[t2, [b]],
		])
	})
})
