import {
	stringifyAutomergeUrl,
	type AutomergeUrl,
} from "@automerge/automerge-repo/slim"
import {
	findLink,
	folderLinks,
	folderTitle,
	isFolder,
	segmentFor,
} from "./folders.ts"
import type {Location} from "./location.ts"

/** A location, followed down to the document it names. */
export type Resolved = {
	projectUrl: AutomergeUrl
	projectName: string
	/** undefined for the project itself, where nothing is open yet */
	docUrl?: AutomergeUrl
	/** one step per segment: the folder searched and the entry found in it */
	trail: Step[]
}

export type Step = {
	folderUrl: AutomergeUrl
	url: AutomergeUrl
	/** the canonical segment for the entry, as it's named right now */
	segment: string
}

export type Rejection = "not-a-project" | "not-found" | "unavailable"

export class LocationError extends Error {
	constructor(readonly reason: Rejection) {
		super(REJECTIONS[reason])
	}
}

export type FindDoc = (url: AutomergeUrl) => Promise<unknown>

/** Follow a location down from its project. Only a folder can be a project. */
export async function resolveLocation(
	location: Location,
	find: FindDoc
): Promise<Resolved> {
	const projectUrl = stringifyAutomergeUrl({documentId: location.projectId})
	const project = await findFolder(projectUrl, find, "not-a-project")
	const trail: Step[] = []
	let folderUrl = projectUrl
	let folder = project
	for (const [index, segment] of location.segments.entries()) {
		const links = folderLinks(folder)
		const link = findLink(links, segment)
		if (!link) throw new LocationError("not-found")
		trail.push({folderUrl, url: link.url, segment: segmentFor(link, links)})
		if (index === location.segments.length - 1) break
		folder = await findFolder(link.url, find, "not-found")
		folderUrl = link.url
	}
	const last = trail.at(-1)?.url
	return {
		projectUrl,
		projectName: folderTitle(project),
		docUrl: last && withHeads(last, location.heads),
		trail,
	}
}

/** Whether the document a location names is itself a folder. */
export async function endsInFolder(
	resolved: Resolved,
	find: FindDoc
): Promise<boolean> {
	const last = resolved.trail.at(-1)
	return last ? isFolder(await find(last.url)) : false
}

/** The same project, with nothing open. */
export function projectRoot(resolved: Resolved): Resolved {
	return {...resolved, docUrl: undefined, trail: []}
}

/**
 * Re-read a resolved location's folders, after a rename say, and name each
 * step as it's named now. Undefined once an entry on the way is gone.
 */
export async function relocate(
	resolved: Resolved,
	find: FindDoc
): Promise<Resolved | undefined> {
	const project = await find(resolved.projectUrl)
	const trail: Step[] = []
	for (const step of resolved.trail) {
		const links = folderLinks(await find(step.folderUrl))
		const link = links.find(link => link.url === step.url)
		if (!link) return undefined
		trail.push({...step, segment: segmentFor(link, links)})
	}
	return {...resolved, projectName: folderTitle(project), trail}
}

const REJECTIONS: Record<Rejection, string> = {
	"not-a-project": "That link doesn't point at a project folder.",
	"not-found": "Nothing in this project is at that path.",
	unavailable: "That project couldn't be loaded.",
}

async function findFolder(
	url: AutomergeUrl,
	find: FindDoc,
	otherwise: Rejection
) {
	let doc: unknown
	try {
		doc = await find(url)
	} catch {
		throw new LocationError("unavailable")
	}
	if (!isFolder(doc)) throw new LocationError(otherwise)
	return doc
}

function withHeads(url: AutomergeUrl, heads?: string): AutomergeUrl {
	return heads ? (`${url}#${heads}` as AutomergeUrl) : url
}
