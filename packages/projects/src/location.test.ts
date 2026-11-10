import type {DocumentId} from "@automerge/automerge-repo/slim"
import {describe, expect, it} from "vitest"
import {
	formatHash,
	formatLocationUrl,
	parseHash,
	parseLocationUrl,
	slugify,
} from "./location.ts"

const PROJECT = "3regSr3818zmNnyXN5EobkuGtGhB" as DocumentId

describe("parseLocationUrl", () => {
	it("reads a project on its own", () => {
		expect(parseLocationUrl(`automerge:${PROJECT}`)).toEqual({
			projectId: PROJECT,
			segments: [],
		})
	})

	it("reads the path into the project, decoding each name", () => {
		expect(
			parseLocationUrl(`automerge:${PROJECT}/Design%20Notes/Q3%2FQ4`)
		).toEqual({projectId: PROJECT, segments: ["Design Notes", "Q3/Q4"]})
	})

	it("keeps heads apart from the path", () => {
		expect(parseLocationUrl(`automerge:${PROJECT}/notes#abc|def`)).toEqual({
			projectId: PROJECT,
			segments: ["notes"],
			heads: "abc|def",
		})
	})

	it("rejects anything that isn't an automerge location", () => {
		expect(parseLocationUrl("https://example.com")).toBeUndefined()
		expect(parseLocationUrl("automerge:not-an-id/notes")).toBeUndefined()
		expect(parseLocationUrl(`automerge:${PROJECT}/%E0%A4%A`)).toBeUndefined()
	})
})

describe("parseHash", () => {
	it("ignores the slug and reads the tool", () => {
		expect(
			parseHash(`q3-planning/automerge:${PROJECT}/Roadmap?tool=markdown`)
		).toEqual({projectId: PROJECT, segments: ["Roadmap"], toolId: "markdown"})
	})

	it("reads a hash with no slug", () => {
		expect(parseHash(`automerge:${PROJECT}`)).toEqual({
			projectId: PROJECT,
			segments: [],
		})
	})

	it("rejects a hash with no location in it", () => {
		expect(parseHash("doc=whatever")).toBeUndefined()
	})
})

describe("formatHash", () => {
	it("writes slug, location, heads and tool, and reads back the same", () => {
		const location = {
			projectId: PROJECT,
			segments: ["Design Notes", "a?b#c"],
			heads: "abc",
			toolId: "markdown",
		}
		const hash = formatHash(location, "Q3 Planning!")
		expect(hash).toBe(
			`q3-planning/automerge:${PROJECT}/Design%20Notes/a%3Fb%23c#abc?tool=markdown`
		)
		expect(parseHash(hash)).toEqual(location)
	})

	it("leaves the slug out when the name has nothing to make one from", () => {
		expect(formatHash({projectId: PROJECT, segments: []}, "!!!")).toBe(
			formatLocationUrl({projectId: PROJECT, segments: []})
		)
	})
})

describe("slugify", () => {
	it("keeps letters from any script and drops accents", () => {
		expect(slugify("Café Notes")).toBe("cafe-notes")
		expect(slugify("会議 メモ")).toBe("会議-メモ")
	})

	it("can't produce something the parser would mistake for the location", () => {
		expect(slugify("automerge: stuff")).toBe("automerge-stuff")
	})
})
