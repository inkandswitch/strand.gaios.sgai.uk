import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {
	createDocOfDatatype2,
	getRegistry,
	isLoadedPlugin,
	type DatatypeDescription,
	type LoadedDatatype,
} from "@inkandswitch/patchwork-plugins"
import {asString, folderLinks, type Link} from "./folders.ts"

/**
 * A root on the recents list: when it was first made or opened here (unset
 * for entries from before that was kept), and whether it's pinned.
 */
export type Recent = Link & {firstOpened?: number; pinned: boolean}

/** The recents list's entries, most recently opened first. */
export function recentsOf(doc: unknown): Recent[] {
	const entries: unknown[] = Array.isArray((doc as any)?.docs) ? (doc as any).docs : []
	const links = folderLinks(doc)
	return links.map(link => {
		const entry = entries.find(each => asString((each as any)?.url) === link.url) as any
		const firstOpened = typeof entry?.firstOpened === "number" ? entry.firstOpened : undefined
		return {...link, firstOpened, pinned: entry?.pinned === true}
	})
}

/**
 * Put a root at the top of the recents list, under its current name and
 * datatype, keeping when it was first opened (now, the first time) and
 * whether it's pinned. Every older entry for it goes, so two tabs racing to
 * add the same root can't leave it in the list twice.
 */
export function addToRecents(
	recents: DocHandle<FolderDoc>,
	projectUrl: AutomergeUrl,
	name: string,
	type: string,
	now = Date.now()
) {
	const list = recentsOf(recents.doc())
	const listed = list.filter(recent => recent.url === projectUrl)
	const first = list[0]
	if (
		first?.url === projectUrl &&
		first.name === name &&
		first.type === type &&
		first.firstOpened !== undefined &&
		listed.length === 1
	)
		return
	const opened = listed.flatMap(recent => (recent.firstOpened === undefined ? [] : [recent.firstOpened]))
	const firstOpened = opened.length ? Math.min(...opened) : now
	const pinned = listed.some(recent => recent.pinned)
	recents.change(doc => {
		if (!Array.isArray(doc.docs)) doc.docs = []
		removeEntries(doc, projectUrl)
		const entry = {name, type, url: projectUrl, firstOpened, ...(pinned ? {pinned} : {})}
		doc.docs.splice(0, 0, entry as FolderDoc["docs"][number])
	})
}

/** Pin a root to the top of the list, or take it off there. */
export function setPinned(recents: DocHandle<FolderDoc>, projectUrl: AutomergeUrl, pinned: boolean) {
	recents.change(doc => {
		if (!Array.isArray(doc.docs)) return
		for (const entry of doc.docs as any[]) {
			if (asString(entry?.url) !== projectUrl) continue
			if (pinned) entry.pinned = true
			else delete entry.pinned
		}
	})
}

export type RecentGroup = {label: string; recents: Recent[]}

/**
 * The list as it's shown: what's pinned, then the rest by when each was
 * first opened, newest first, under how long ago that was. Entries from
 * before that was kept come last, as they're listed.
 */
export function groupRecents(list: Recent[], now = new Date()): RecentGroup[] {
	const groups: RecentGroup[] = [{label: "Pinned", recents: list.filter(recent => recent.pinned)}]
	const dated = list
		.filter(recent => !recent.pinned && recent.firstOpened !== undefined)
		.sort((a, b) => b.firstOpened! - a.firstOpened!)
	const undated = list.filter(recent => !recent.pinned && recent.firstOpened === undefined)
	const today = startOfDay(now)
	const day = 24 * 60 * 60 * 1000
	const ranges: [string, (time: number) => boolean][] = [
		["Today", time => time >= today],
		["Yesterday", time => time >= today - day],
		["This week", time => time >= today - 6 * day],
		[
			"This month",
			time => {
				const date = new Date(time)
				return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
			},
		],
		["Older", () => true],
	]
	const byRange = ranges.map(([label]) => ({label, recents: [] as Recent[]}))
	for (const recent of dated) {
		const index = ranges.findIndex(([, holds]) => holds(recent.firstOpened!))
		byRange[index]!.recents.push(recent)
	}
	byRange.at(-1)!.recents.push(...undated)
	return [...groups, ...byRange].filter(group => group.recents.length > 0)
}

/** What a new document is called until it's named: when it was made, "Mon 10:37 AM". */
export function nameForNew(date = new Date()) {
	return date.toLocaleString(undefined, {weekday: "short", hour: "numeric", minute: "2-digit"})
}

function startOfDay(date: Date) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Take a project off the list. The project folder itself is left alone. */
export function removeFromRecents(
	recents: DocHandle<FolderDoc>,
	projectUrl: AutomergeUrl
) {
	recents.change(doc => removeEntries(doc, projectUrl))
}

/** A new document of `type`, its title set when it's given one. */
export async function createDocument(repo: Repo, type: string, title?: string) {
	const datatype = await getRegistry<DatatypeDescription>("patchwork:datatype").load(type)
	if (!datatype || !isLoadedPlugin(datatype))
		throw new Error(`projects: the ${type} datatype isn't installed`)
	const loaded = datatype as LoadedDatatype<unknown>
	const handle = await createDocOfDatatype2(loaded, repo, doc => {
		if (title !== undefined) loaded.module.setTitle?.(doc, title)
	})
	return handle.url
}

function removeEntries(doc: FolderDoc, projectUrl: AutomergeUrl) {
	if (!Array.isArray(doc.docs)) return
	for (let index = doc.docs.length - 1; index >= 0; index--) {
		if (asString(doc.docs[index]?.url) === projectUrl) doc.docs.splice(index, 1)
	}
}
