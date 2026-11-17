import {beforeAll, describe as group, it, expect} from "vitest"
import {Repo, initSubduction, splice, type AutomergeUrl} from "@automerge/automerge-repo"
import {addAnchor, replaceFileContent} from "./components/comments/anchors"
import {rangeRef} from "./components/comments/threads"
import {cropFor, describe} from "./ref-view"

beforeAll(() => initSubduction())

const resolve = (repo: Repo, urls: AutomergeUrl[]) =>
	Promise.all(urls.map((url) => repo.find(url)))

const image = () => {
	const repo = new Repo()
	const handle = repo.create<any>({content: new Uint8Array([1, 2, 3])})
	return {repo, handle}
}

group("describe", () => {
	it("names a pin and a region", async () => {
		const {repo, handle} = image()
		const pin = addAnchor(handle, {x: 0.5, y: 0.5, w: 0, h: 0})
		const region = addAnchor(handle, {x: 0.1, y: 0.1, w: 0.2, h: 0.2})
		expect(describe(await resolve(repo, [pin]), handle)).toBe("")
		expect(describe(await resolve(repo, [region]), handle)).toBe("")
	})

	it("hides a thread whose anchor was cleared by a replacement", async () => {
		const {repo, handle} = image()
		const refs = [addAnchor(handle, {x: 0.5, y: 0.5, w: 0, h: 0})]
		const targets = await resolve(repo, refs)
		replaceFileContent(handle, new Uint8Array([4, 5, 6]))
		expect(describe(targets, handle)).toBe(false)
	})

	it("hides a thread whose image was replaced without clearing anchors", async () => {
		const {repo, handle} = image()
		const refs = [addAnchor(handle, {x: 0.5, y: 0.5, w: 0, h: 0})]
		handle.change((doc: any) => {
			doc.content = new Uint8Array([7, 8, 9, 10])
		})
		expect(describe(await resolve(repo, refs), handle)).toBe(false)
	})

	it("quotes a text range, and gives null once it's deleted", async () => {
		const repo = new Repo()
		const handle = repo.create<any>({content: "the quick brown fox"})
		const targets = await resolve(repo, [rangeRef(handle, ["content"], 4, 9)])
		expect(describe(targets, handle)).toBe("“quick”")

		handle.change((doc: any) => splice(doc, ["content"], 2, 10))
		expect(describe(targets, handle)).toBeNull()
	})

	it("gives null for anything else", async () => {
		const {repo, handle} = image()
		handle.change((doc: any) => (doc.name = "x.png"))
		expect(describe(await resolve(repo, [handle.sub("name").url]), handle)).toBeNull()
	})
})

group("cropFor", () => {
	const natural = {width: 1000, height: 500}

	it("keeps a region with room around it, at the box's aspect ratio, inside the image", () => {
		const crop = cropFor({x: 0.4, y: 0.4, w: 0.1, h: 0.2}, natural, 44 / 28)
		expect(crop.width / crop.height).toBeCloseTo(44 / 28)
		expect(crop.x).toBeLessThanOrEqual(400)
		expect(crop.x + crop.width).toBeGreaterThanOrEqual(500)
		expect(crop.y).toBeGreaterThanOrEqual(0)
		expect(crop.y + crop.height).toBeLessThanOrEqual(500)
	})

	it("shifts a crop around a pin near the edge back inside the image", () => {
		const crop = cropFor({x: 0, y: 1, w: 0, h: 0}, natural, 1)
		expect(crop.x).toBe(0)
		expect(crop.y + crop.height).toBeCloseTo(500)
	})
})
