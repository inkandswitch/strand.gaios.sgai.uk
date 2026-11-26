import {parseAutomergeUrl, type AutomergeUrl} from "@automerge/automerge-repo/slim"
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
