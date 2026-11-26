import {parseAutomergeUrl, type AutomergeUrl} from "@automerge/automerge-repo/slim"
import {segmentFor, type Link} from "./folders.ts"
import type {At, HistoryEntry, Member} from "./types.ts"

/*
 * Reading the overlay provider's `overlay:members` and `overlay:history`:
 * what's beneath a folder, and when each member was last edited. Members
 * are told apart by document, since a url may carry heads.
 */

export function documentOf(url: AutomergeUrl): string {
	return parseAutomergeUrl(url).documentId
}

/** Each member's parent, by document. */
export function parentsOf(members: readonly Member[]): Map<string, AutomergeUrl | null> {
	return new Map(members.map(member => [documentOf(member.url), member.parent]))
}

/** `url` and every member above it, by document, nearest first. */
export function upFrom(url: AutomergeUrl, parents: Map<string, AutomergeUrl | null>): string[] {
	const out: string[] = []
	let cursor: AutomergeUrl | null | undefined = url
	while (cursor && !out.includes(documentOf(cursor))) {
		out.push(documentOf(cursor))
		cursor = parents.get(documentOf(cursor))
	}
	return out
}

/** Whether `url` is `folder` or beneath it. */
export function isBeneath(
	url: AutomergeUrl,
	folder: AutomergeUrl,
	parents: Map<string, AutomergeUrl | null>
): boolean {
	return upFrom(url, parents).includes(documentOf(folder))
}

/**
 * When each member was last edited, by document, in Unix seconds: the newest
 * history entry that changed it, or, for a folder, anything beneath it. At a
 * point in history, only entries up to that point count.
 */
export function lastEdited(
	entries: readonly HistoryEntry[],
	members: readonly Member[],
	at: At
): Map<string, number> {
	const parents = parentsOf(members)
	const start = at === null ? 0 : Math.max(0, entries.findIndex(entry => entry.id === at))
	const out = new Map<string, number>()
	// newest first, so the first time a member is seen is its latest
	for (const entry of entries.slice(start))
		for (const url of entry.members)
			for (const id of upFrom(url, parents)) if (!out.has(id)) out.set(id, entry.time)
	return out
}

/** How a document differs between the two versions compared. */
export type Side = "both" | "ours" | "theirs"

/** A document under review: how it differs, and the entries down to it. */
export type Section = {
	url: AutomergeUrl
	/** in both versions and different, or only in A (ours) or B (theirs) */
	side: Side
	/** the entries from the folder reviewed down to it, it last */
	steps: {name: string; segment: string}[]
}

/** A folder's entries, as `folders.ts` reads them; undefined until loaded. */
export type LinksOf = (url: AutomergeUrl) => readonly Link[] | undefined

/**
 * The documents beneath `folder`, at any depth, that differ between `ours`
 * (A) and `theirs` (B): heads that differ, or only one version has them.
 * Folders are left out. They come in the tree's order: each folder's
 * entries in its order, going down into folders as they come, then what
 * only B has in that folder.
 */
export function review(
	folder: AutomergeUrl,
	ours: readonly Member[],
	theirs: readonly Member[],
	ourLinks: LinksOf,
	theirLinks: LinksOf
): Section[] {
	const byOurs = new Map(ours.map(member => [documentOf(member.url), member]))
	const byTheirs = new Map(theirs.map(member => [documentOf(member.url), member]))
	const ourParents = parentsOf(ours)
	const theirParents = parentsOf(theirs)
	const parents = new Set<string>()
	for (const member of [...ours, ...theirs]) if (member.parent) parents.add(documentOf(member.parent))

	const sideOf = (id: string): Side | undefined => {
		const a = byOurs.get(id)
		const b = byTheirs.get(id)
		if (a && b) return sameHeads(a.heads, b.heads) ? undefined : "both"
		return a ? "ours" : b ? "theirs" : undefined
	}

	// What differs, and every folder above it, to go down into.
	const holding = new Set<string>()
	for (const member of ours)
		if (sideOf(documentOf(member.url))) for (const id of upFrom(member.url, ourParents)) holding.add(id)
	// B's own documents, by the nearest folder A has above them.
	const onlyTheirs = new Map<string, Member[]>()
	for (const member of theirs) {
		const id = documentOf(member.url)
		if (byOurs.has(id) || parents.has(id)) continue
		const above = upFrom(member.url, theirParents).find(each => byOurs.has(each))
		if (!above) continue
		for (const each of upFrom(byOurs.get(above)!.url, ourParents)) holding.add(each)
		onlyTheirs.set(above, [...(onlyTheirs.get(above) ?? []), member])
	}

	const out: Section[] = []
	const seen = new Set<string>()
	const visit = (url: AutomergeUrl, steps: Section["steps"]) => {
		const id = documentOf(url)
		if (seen.has(id)) return
		seen.add(id)
		const links = ourLinks(url) ?? []
		for (const link of links) {
			const child = documentOf(link.url)
			const step = {name: link.name, segment: segmentFor(link, links)}
			if (link.type === "folder" || parents.has(child)) {
				if (holding.has(child)) visit(link.url, [...steps, step])
				continue
			}
			const side = sideOf(child)
			if (side) out.push({url: link.url, side, steps: [...steps, step]})
		}
		for (const member of onlyTheirs.get(id) ?? []) {
			const theirSteps = stepsDown(member.url, id, theirParents, theirLinks)
			if (theirSteps) out.push({url: member.url, side: "theirs", steps: [...steps, ...theirSteps]})
		}
	}
	if (byOurs.has(documentOf(folder))) visit(folder, [])
	return out
}

/**
 * The folders whose entries `review` reads: in A, `folder` and every folder
 * beneath it down to what differs; in B, the folders above what only B has,
 * up to the nearest one A has too.
 */
export function foldersToRead(
	folder: AutomergeUrl,
	ours: readonly Member[],
	theirs: readonly Member[]
): {ours: AutomergeUrl[]; theirs: AutomergeUrl[]} {
	const top = documentOf(folder)
	const byOurs = new Map(ours.map(member => [documentOf(member.url), member]))
	const byTheirs = new Map(theirs.map(member => [documentOf(member.url), member]))
	const ourParents = parentsOf(ours)
	const theirParents = parentsOf(theirs)
	const a = new Set<AutomergeUrl>()
	const b = new Set<AutomergeUrl>()
	// The folders from `url` up to `folder`, if it's beneath it.
	const upTo = (url: AutomergeUrl) => {
		const chain = upFrom(url, ourParents)
		const end = chain.indexOf(top)
		return end < 0 ? [] : chain.slice(1, end + 1)
	}
	for (const member of ours) {
		const other = byTheirs.get(documentOf(member.url))
		if (other && sameHeads(member.heads, other.heads)) continue
		for (const id of upTo(member.url)) a.add(byOurs.get(id)!.url)
	}
	for (const member of theirs) {
		if (byOurs.has(documentOf(member.url))) continue
		const chain = upFrom(member.url, theirParents).slice(1)
		const shared = chain.findIndex(id => byOurs.has(id))
		if (shared < 0) continue
		const above = byOurs.get(chain[shared])!.url
		if (chain[shared] !== top && !upTo(above).length) continue
		for (const id of chain.slice(0, shared + 1)) b.add(byTheirs.get(id)!.url)
		a.add(above)
		for (const each of upTo(above)) a.add(byOurs.get(each)!.url)
	}
	return {ours: [...a], theirs: [...b]}
}

// The entries from the folder `from` (not included) down to `url`, in B, or
// undefined while a folder on the way hasn't been read.
function stepsDown(
	url: AutomergeUrl,
	from: string,
	parents: Map<string, AutomergeUrl | null>,
	linksOf: LinksOf
): Section["steps"] | undefined {
	const steps: Section["steps"] = []
	let cursor: AutomergeUrl = url
	while (documentOf(cursor) !== from) {
		const parent = parents.get(documentOf(cursor))
		if (!parent) return undefined
		const links = linksOf(parent)
		const link = links?.find(each => documentOf(each.url) === documentOf(cursor))
		if (!links || !link) return undefined
		steps.unshift({name: link.name, segment: segmentFor(link, links)})
		cursor = parent
	}
	return steps
}

function sameHeads(a: readonly string[], b: readonly string[]) {
	if (a.length !== b.length) return false
	const set = new Set(b)
	return a.every(head => set.has(head))
}

/**
 * What the history and the comments cover: what's shown, each folder as
 * every member beneath it, in the order shown. `whole` when the root is
 * among them.
 */
export function covered(
	shown: readonly AutomergeUrl[],
	members: readonly Member[],
	root: AutomergeUrl
): {whole: boolean; docs: AutomergeUrl[]} {
	const parents = parentsOf(members)
	const docs: AutomergeUrl[] = []
	const seen = new Set<string>()
	const add = (url: AutomergeUrl) => {
		const id = documentOf(url)
		if (seen.has(id)) return
		seen.add(id)
		docs.push(url)
	}
	for (const url of shown) {
		add(url)
		const id = documentOf(url)
		for (const member of members) if (upFrom(member.url, parents).includes(id)) add(member.url)
	}
	const whole = shown.length === 0 || shown.some(url => documentOf(url) === documentOf(root))
	return {whole, docs}
}
