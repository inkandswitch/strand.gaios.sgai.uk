import {isValidDocumentId, type DocumentId} from "@automerge/automerge-repo/slim"

/**
 * Where something sits inside a project: the project folder's document id,
 * then the names of the entries leading down to it.
 *
 * As a url (what open events carry): `automerge:<projectId>/<name>/<name>#<heads>`
 * In the hash, behind a slug of the project's name and ahead of the tool:
 * `#<slug>/automerge:<projectId>/<name>/<name>#<heads>?tool=<toolId>`
 */
export type Location = {
	projectId: DocumentId
	/** decoded entry names, or document ids where a name is ambiguous */
	segments: string[]
	heads?: string
	toolId?: string
}

const SCHEME = "automerge:"

/** Read a location out of the hash, ignoring its slug. */
export function parseHash(hash: string): Location | undefined {
	const start = hash.indexOf(SCHEME)
	if (start < 0) return undefined
	const [url, query] = split(hash.slice(start), "?")
	const location = parseLocationUrl(url)
	if (!location) return undefined
	const toolId = new URLSearchParams(query).get("tool")
	return toolId ? {...location, toolId} : location
}

export function parseLocationUrl(url: string): Location | undefined {
	if (!url.startsWith(SCHEME)) return undefined
	const [path, heads] = split(url.slice(SCHEME.length), "#")
	const [projectId, ...rest] = path.split("/")
	if (!isValidDocumentId(projectId)) return undefined
	const segments = decodeSegments(rest.filter(Boolean))
	if (!segments) return undefined
	return heads ? {projectId, segments, heads} : {projectId, segments}
}

export function formatHash(location: Location, projectName: string) {
	const slug = slugify(projectName)
	const tool = location.toolId
		? `?tool=${encodeURIComponent(location.toolId)}`
		: ""
	return `${slug ? `${slug}/` : ""}${formatLocationUrl(location)}${tool}`
}

export function formatLocationUrl({projectId, segments, heads}: Location) {
	const path = segments.map(segment => `/${encodeURIComponent(segment)}`)
	return `${SCHEME}${projectId}${path.join("")}${heads ? `#${heads}` : ""}`
}

/** Lowercase letters and digits from any script, joined by dashes. */
export function slugify(name: string) {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
}

function decodeSegments(segments: string[]) {
	try {
		return segments.map(decodeURIComponent)
	} catch {
		return undefined
	}
}

function split(value: string, separator: string): [string, string] {
	const index = value.indexOf(separator)
	if (index < 0) return [value, ""]
	return [value.slice(0, index), value.slice(index + 1)]
}
