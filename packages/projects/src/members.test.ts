import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {describe, expect, it} from "vitest"
import {documentOf, foldersToRead, lastEdited, review} from "./members.ts"
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

describe("review", () => {
	const NOTEBOOK = "automerge:3LaP9w5ShGCKVr8aCr9crgRBFRBz" as AutomergeUrl
	const ours = [
		{url: ROOT, heads: ["r1"], parent: null},
		{url: FIGURES, heads: ["f1"], parent: ROOT},
		{url: CHART, heads: ["c2"], parent: FIGURES},
		{url: CONFIG, heads: ["k1"], parent: ROOT},
	]
	const theirs = [
		{url: ROOT, heads: ["r2"], parent: null},
		{url: FIGURES, heads: ["f2"], parent: ROOT},
		{url: CHART, heads: ["c1"], parent: FIGURES},
		{url: CONFIG, heads: ["k1"], parent: ROOT},
		{url: NOTEBOOK, heads: ["n1"], parent: FIGURES},
	]
	const ourFolders: Record<string, {name: string; type: string; url: AutomergeUrl}[]> = {
		[ROOT]: [
			{name: "config.yaml", type: "file", url: CONFIG},
			{name: "figures", type: "folder", url: FIGURES},
		],
		[FIGURES]: [{name: "chart.png", type: "file", url: CHART}],
	}
	const theirFolders: typeof ourFolders = {
		[FIGURES]: [
			{name: "chart.png", type: "file", url: CHART},
			{name: "notes.ipynb", type: "file", url: NOTEBOOK},
		],
	}

	it("lists what differs beneath a folder in the tree's order, folders left out", () => {
		const sections = review(ROOT, ours, theirs, url => ourFolders[url], url => theirFolders[url])
		expect(sections).toEqual([
			{
				url: CHART,
				side: "both",
				steps: [
					{name: "figures", segment: "figures"},
					{name: "chart.png", segment: "chart.png"},
				],
			},
			{
				url: NOTEBOOK,
				side: "theirs",
				steps: [
					{name: "figures", segment: "figures"},
					{name: "notes.ipynb", segment: "notes.ipynb"},
				],
			},
		])
	})

	it("reads the folders on the way down, in both versions", () => {
		const read = foldersToRead(ROOT, ours, theirs)
		expect(new Set(read.ours)).toEqual(new Set([ROOT, FIGURES]))
		expect(read.theirs).toEqual([FIGURES])
		expect(foldersToRead(FIGURES, ours, theirs).ours).toEqual([FIGURES])
	})

	it("only looks beneath the folder reviewed", () => {
		const sections = review(FIGURES, ours, theirs, url => ourFolders[url], url => theirFolders[url])
		expect(sections.map(section => section.steps.map(step => step.name))).toEqual([
			["chart.png"],
			["notes.ipynb"],
		])
	})
})
