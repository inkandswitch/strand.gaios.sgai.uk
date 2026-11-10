import type {AutomergeUrl, DocumentId} from "@automerge/automerge-repo/slim"
import {describe, expect, it} from "vitest"
import type {Location} from "./location.ts"
import {LocationError, relocate, resolveLocation} from "./resolve.ts"

const PROJECT = "automerge:3regSr3818zmNnyXN5EobkuGtGhB" as AutomergeUrl
const NOTES = "automerge:41DCUsb2mbtrzLAwAbxbMyF8zDfF" as AutomergeUrl
const ROADMAP = "automerge:3Dgi4umWwcDVUXhyLYWLeoRRhzWh" as AutomergeUrl
const OTHER = "automerge:4RwwSmVeLXRPz6qGaComRg2mo4Mr" as AutomergeUrl

const idOf = (url: AutomergeUrl) => url.slice("automerge:".length) as DocumentId

function folder(title: string, docs: {name: string; type: string; url: AutomergeUrl}[]) {
	return {"@patchwork": {type: "folder"}, title, docs}
}

function repo(docs: Record<string, unknown>) {
	return async (url: AutomergeUrl) => {
		if (!(url in docs)) throw new Error(`unavailable: ${url}`)
		return docs[url]
	}
}

const docs = {
	[PROJECT]: folder("Q3 Planning", [
		{name: "Notes", type: "folder", url: NOTES},
	]),
	[NOTES]: folder("Notes", [
		{name: "Roadmap", type: "md", url: ROADMAP},
		{name: "Ideas", type: "md", url: OTHER},
	]),
	[ROADMAP]: {"@patchwork": {type: "md"}, content: ""},
	[OTHER]: {"@patchwork": {type: "md"}, content: ""},
}

const at = (...segments: string[]): Location => ({
	projectId: idOf(PROJECT),
	segments,
})

describe("resolveLocation", () => {
	it("opens a project with nothing selected", async () => {
		const resolved = await resolveLocation(at(), repo(docs))
		expect(resolved).toEqual({
			projectUrl: PROJECT,
			projectName: "Q3 Planning",
			docUrl: undefined,
			trail: [],
		})
	})

	it("follows names down to the document", async () => {
		const resolved = await resolveLocation(at("Notes", "Roadmap"), repo(docs))
		expect(resolved.docUrl).toBe(ROADMAP)
		expect(resolved.trail).toEqual([
			{folderUrl: PROJECT, url: NOTES, segment: "Notes"},
			{folderUrl: NOTES, url: ROADMAP, segment: "Roadmap"},
		])
	})

	it("follows a document id where a name was ambiguous", async () => {
		const resolved = await resolveLocation(
			at("Notes", idOf(OTHER)),
			repo(docs)
		)
		expect(resolved.docUrl).toBe(OTHER)
	})

	it("names an entry by document id when its siblings share its name", async () => {
		const clashing = {
			...docs,
			[NOTES]: folder("Notes", [
				{name: "Roadmap", type: "md", url: ROADMAP},
				{name: "Roadmap", type: "md", url: OTHER},
			]),
		}
		const resolved = await resolveLocation(
			at("Notes", idOf(OTHER)),
			repo(clashing)
		)
		expect(resolved.trail[1].segment).toBe(idOf(OTHER))
	})

	it("puts heads on the document, not the project", async () => {
		const resolved = await resolveLocation(
			{...at("Notes", "Roadmap"), heads: "abc"},
			repo(docs)
		)
		expect(resolved.docUrl).toBe(`${ROADMAP}#abc`)
	})

	it("only takes a folder as a project", async () => {
		await expect(
			resolveLocation({projectId: idOf(ROADMAP), segments: []}, repo(docs))
		).rejects.toEqual(new LocationError("not-a-project"))
	})

	it("rejects a path that isn't there", async () => {
		await expect(
			resolveLocation(at("Notes", "Nope"), repo(docs))
		).rejects.toEqual(new LocationError("not-found"))
		await expect(
			resolveLocation(at("Notes", "Roadmap", "deeper"), repo(docs))
		).rejects.toEqual(new LocationError("not-found"))
	})

	it("says so when the project can't be loaded", async () => {
		await expect(resolveLocation(at(), repo({}))).rejects.toEqual(
			new LocationError("unavailable")
		)
	})
})

describe("relocate", () => {
	it("picks up renames along the way", async () => {
		const resolved = await resolveLocation(at("Notes", "Roadmap"), repo(docs))
		const renamed = {
			...docs,
			[PROJECT]: folder("Q4 Planning", [
				{name: "Notes", type: "folder", url: NOTES},
			]),
			[NOTES]: folder("Notes", [
				{name: "2027 Roadmap", type: "md", url: ROADMAP},
			]),
		}
		const next = await relocate(resolved, repo(renamed))
		expect(next?.projectName).toBe("Q4 Planning")
		expect(next?.trail.map(step => step.segment)).toEqual([
			"Notes",
			"2027 Roadmap",
		])
	})

	it("gives up when an entry on the way has gone", async () => {
		const resolved = await resolveLocation(at("Notes", "Roadmap"), repo(docs))
		const moved = {...docs, [NOTES]: folder("Notes", [])}
		expect(await relocate(resolved, repo(moved))).toBeUndefined()
	})
})
