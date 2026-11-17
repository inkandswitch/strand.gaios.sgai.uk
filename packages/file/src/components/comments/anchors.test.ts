import {beforeAll, describe, it, expect} from "vitest"
import {Repo, initSubduction, type AutomergeUrl} from "@automerge/automerge-repo"
import {
	anchoredThreads,
	anchorIsCurrent,
	containRect,
	contentFingerprint,
	addAnchor,
	removeAnchor,
	isPin,
	normaliseAnchor,
	quote,
	replaceFileContent,
	type DocWithAnchors,
} from "./anchors"

beforeAll(() => initSubduction())

const thread = (n: number) => `automerge:thread${n}` as AutomergeUrl
const box = {width: 200, height: 100}

describe("normaliseAnchor", () => {
	it("makes a short press a pin", () => {
		expect(normaliseAnchor({x: 50, y: 25}, {x: 52, y: 26}, box)).toEqual({
			x: 0.25,
			y: 0.25,
			w: 0,
			h: 0,
		})
	})

	it("makes a drag the region it spans, whichever way it went", () => {
		const region = {x: 0.1, y: 0.2, w: 0.4, h: 0.6}
		expect(normaliseAnchor({x: 20, y: 20}, {x: 100, y: 80}, box)).toEqual(region)
		expect(normaliseAnchor({x: 100, y: 80}, {x: 20, y: 20}, box)).toEqual(region)
	})

	it("clamps to the image", () => {
		expect(normaliseAnchor({x: 150, y: 50}, {x: 400, y: -30}, box)).toEqual({
			x: 0.75,
			y: 0,
			w: 0.25,
			h: 0.5,
		})
	})

	it("tells pins from regions", () => {
		expect(isPin({x: 0.5, y: 0.5, w: 0, h: 0})).toBe(true)
		expect(isPin({x: 0.5, y: 0.5, w: 0.1, h: 0.1})).toBe(false)
	})
})

describe("containRect", () => {
	it("letterboxes a wide image in a tall box", () => {
		expect(containRect({width: 100, height: 200}, {width: 400, height: 200})).toEqual({
			left: 0,
			top: 75,
			width: 100,
			height: 50,
		})
	})

	it("pillarboxes a tall image in a wide box", () => {
		expect(containRect({width: 300, height: 100}, {width: 50, height: 100})).toEqual({
			left: 125,
			top: 0,
			width: 50,
			height: 100,
		})
	})

	it("never scales up with scale-down", () => {
		expect(
			containRect({width: 300, height: 300}, {width: 100, height: 50}, "scale-down"),
		).toEqual({left: 100, top: 125, width: 100, height: 50})
	})
})

describe("contentFingerprint", () => {
	it("is the same for the same bytes and differs for others", () => {
		const a = contentFingerprint(new Uint8Array([1, 2, 3]))
		expect(contentFingerprint(new Uint8Array([1, 2, 3]))).toBe(a)
		expect(contentFingerprint(new Uint8Array([1, 2, 4]))).not.toBe(a)
		expect(contentFingerprint("text")).toBeUndefined()
	})

	it("says whether an anchor still applies", () => {
		const anchor = {x: 0, y: 0, w: 0, h: 0, fingerprint: "3:abc"}
		expect(anchorIsCurrent(anchor, "3:abc")).toBe(true)
		expect(anchorIsCurrent(anchor, "4:def")).toBe(false)
		expect(anchorIsCurrent({x: 0, y: 0, w: 0, h: 0}, "4:def")).toBe(true)
		expect(anchorIsCurrent(undefined, "4:def")).toBe(false)
	})
})

const imageHandle = () => {
	const repo = new Repo()
	const handle = repo.create<DocWithAnchors>({
		content: new Uint8Array([137, 80, 78, 71]),
	} as any)
	return {repo, handle}
}

describe("addAnchor", () => {
	it("stores the anchor, stamped with the bytes, and returns its ref", () => {
		const {handle} = imageHandle()
		const ref = addAnchor(handle, {x: 0.1, y: 0.2, w: 0.3, h: 0.4})
		const doc = handle.doc()
		const [anchorId] = Object.keys(doc["@anchors"]!)
		expect(doc["@anchors"]![anchorId]).toEqual({
			x: 0.1,
			y: 0.2,
			w: 0.3,
			h: 0.4,
			fingerprint: contentFingerprint(doc.content),
		})
		expect(ref).toBe(handle.sub("@anchors", anchorId).url)
		expect((doc as any)["@comments"]).toBeUndefined()
	})

	it("can be taken back off", () => {
		const {handle} = imageHandle()
		const keep = addAnchor(handle, {x: 0.1, y: 0.1, w: 0, h: 0})
		const drop = addAnchor(handle, {x: 0.2, y: 0.2, w: 0, h: 0})
		removeAnchor(handle, drop)
		expect(Object.keys(handle.doc()["@anchors"]!)).toEqual([keep.split("/").pop()])
	})
})

describe("anchoredThreads", () => {
	it("lists the subscribed threads on current anchors, numbered in order", () => {
		const {handle} = imageHandle()
		const a = addAnchor(handle, {x: 0.1, y: 0.1, w: 0, h: 0})
		addAnchor(handle, {x: 0.5, y: 0.5, w: 0.2, h: 0.2})
		const c = addAnchor(handle, {x: 0.9, y: 0.9, w: 0, h: 0})
		const text = handle.sub("name").url
		// b's thread is resolved, so the provider leaves it out
		const list = anchoredThreads(handle.doc(), handle, [
			{targetUrl: text, threadUrl: thread(0)},
			{targetUrl: c, threadUrl: thread(3)},
			{targetUrl: a, threadUrl: thread(1)},
		])
		expect(list.map((t) => [t.index, t.threadUrl, t.anchor.x, t.refs])).toEqual([
			[1, thread(3), 0.9, [c]],
			[2, thread(1), 0.1, [a]],
		])
	})

	it("drops anchors once the bytes are replaced", () => {
		const {handle} = imageHandle()
		const a = addAnchor(handle, {x: 0.1, y: 0.1, w: 0, h: 0})
		handle.change((doc) => {
			doc.content = new Uint8Array([1, 2, 3, 4, 5])
		})
		expect(handle.doc()["@anchors"]).toBeDefined()
		expect(anchoredThreads(handle.doc(), handle, [{targetUrl: a, threadUrl: thread(1)}])).toEqual([])
	})
})

describe("replaceFileContent", () => {
	it("clears the anchors in the same change", () => {
		const {handle} = imageHandle()
		const ref = addAnchor(handle, {x: 0.1, y: 0.1, w: 0, h: 0})
		const heads = handle.heads()
		replaceFileContent(handle, new Uint8Array([9, 9]), "image/png")
		const doc = handle.doc()
		expect(doc["@anchors"]).toBeUndefined()
		expect(doc.content).toEqual(new Uint8Array([9, 9]))
		expect(handle.sub("@anchors", ref.split("/").pop()!).doc()).toBeUndefined()
		expect(handle.view(heads).doc()["@anchors"]).toBeDefined()
	})
})

describe("quote", () => {
	it("quotes short text as is, with whitespace collapsed", () => {
		expect(quote("  hello\n  world ")).toBe("“hello world”")
	})

	it("cuts long text to 60 characters", () => {
		const q = quote("x".repeat(100))
		expect(q.length).toBe(62)
		expect(q.endsWith("…”")).toBe(true)
	})
})
