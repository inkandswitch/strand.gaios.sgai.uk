import {
	stringifyAutomergeUrl,
	type AutomergeUrl,
} from "@automerge/automerge-repo/slim"
import {
	findLink,
	folderLinks,
	asString,
	folderTitle,
	isFolder,
	segmentFor,
} from "./folders.ts"
import type {Location} from "./location.ts"

/**
 * A location, followed down to the document it names. The project is the
 * root, whatever document the location starts at: a folder, laid out as its
 * tree beside what's open in it, or any other document, shown on its own.
 */
export type Resolved = {
	projectUrl: AutomergeUrl
	projectName: string
	/** a folder, with documents open in it, or a document on its own */
	root: "folder" | "document"
	/** the root's datatype */
	rootType: string
	/**
	 * What's open: in a folder, undefined until something is; a document on
	 * its own is itself
	 */
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

/** The project a location is in: the document it starts at, whatever it is. */
export async function findProject(
	location: Location,
	find: FindDoc
): Promise<AutomergeUrl> {
	const projectUrl = projectUrlOf(location)
	await findRoot(projectUrl, find)
	return projectUrl
}

/** Follow a location down from its project. */
export async function resolveLocation(
	location: Location,
	find: FindDoc
): Promise<Resolved> {
	const projectUrl = projectUrlOf(location)
	const project = await findRoot(projectUrl, find)
	const root = isFolder(project) ? "folder" : "document"
	const rootType = asString((project as any)?.["@patchwork"]?.type) ?? ""
	// A document on its own has nothing beneath it to go down into.
	if (root === "document") {
		if (location.segments.length) throw new LocationError("not-found")
		return {
			projectUrl,
			projectName: rootTitle(project),
			root,
			rootType,
			docUrl: withHeads(projectUrl, location.heads),
			trail: [],
		}
	}
	const trail: Step[] = []
	let folderUrl = projectUrl
	let folder: unknown = project
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
		projectName: rootTitle(project),
		root,
		rootType,
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

/** The same project, with nothing open: a document on its own stays open. */
export function projectRoot(resolved: Resolved): Resolved {
	const docUrl = resolved.root === "document" ? resolved.projectUrl : undefined
	return {...resolved, docUrl, trail: []}
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
	return {...resolved, projectName: rootTitle(project), trail}
}

const REJECTIONS: Record<Rejection, string> = {
	"not-a-project": "That link doesn't point at a document.",
	"not-found": "Nothing in this project is at that path.",
	unavailable: "That project couldn't be loaded.",
}

async function findRoot(url: AutomergeUrl, find: FindDoc) {
	let doc: unknown
	try {
		doc = await find(url)
	} catch {
		throw new LocationError("unavailable")
	}
	if (!doc) throw new LocationError("unavailable")
	return doc
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

// A folder's title, or what another document says it's called, until the
// view showing it knows better (see `useDocTitle`).
function rootTitle(doc: unknown) {
	if (isFolder(doc)) return folderTitle(doc)
	const metadata = (doc as any)?.["@patchwork"]
	return asString(metadata?.title) || asString((doc as any)?.title) || "Untitled"
}

function projectUrlOf(location: Location) {
	return stringifyAutomergeUrl({documentId: location.projectId})
}

function withHeads(url: AutomergeUrl, heads?: string): AutomergeUrl {
	return heads ? (`${url}#${heads}` as AutomergeUrl) : url
}
