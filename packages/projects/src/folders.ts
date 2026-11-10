import {
	isImmutableString,
	isValidAutomergeUrl,
	parseAutomergeUrl,
	type AutomergeUrl,
} from "@automerge/automerge-repo/slim"

/** A folder entry, read the same whether its strings are plain or immutable. */
export type Link = {name: string; type: string; url: AutomergeUrl}

export function isFolder(doc: unknown) {
	return asString((doc as any)?.["@patchwork"]?.type) === "folder"
}

export function folderTitle(doc: unknown) {
	return asString((doc as any)?.title) || "Untitled project"
}

export function folderLinks(doc: unknown): Link[] {
	const docs = (doc as any)?.docs
	if (!Array.isArray(docs)) return []
	const links: Link[] = []
	for (const entry of docs) {
		const url = asString(entry?.url)
		if (!url || !isValidAutomergeUrl(url)) continue
		links.push({
			url,
			name: asString(entry.name) ?? "",
			type: asString(entry.type) ?? "",
		})
	}
	return links
}

/**
 * The segment naming `link` among its siblings: its name, or its document id
 * when the name is empty or another entry in the same folder shares it.
 * Sideboard's document list names entries by the same rule.
 */
export function segmentFor(link: Link, siblings: readonly Link[]) {
	const clash = siblings.some(
		sibling => sibling.url !== link.url && sibling.name === link.name
	)
	if (link.name && !clash) return link.name
	return documentIdOf(link.url)
}

/** The entry a segment names: by name first, then by document id. */
export function findLink(links: readonly Link[], segment: string) {
	return (
		links.find(link => link.name === segment) ??
		links.find(link => documentIdOf(link.url) === segment)
	)
}

export function documentIdOf(url: AutomergeUrl): string {
	return parseAutomergeUrl(url).documentId
}

export function asString(value: unknown): string | undefined {
	if (typeof value === "string") return value
	if (isImmutableString(value)) return String(value)
	return undefined
}
