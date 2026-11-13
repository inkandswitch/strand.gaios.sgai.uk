import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {
	createDocOfDatatype2,
	getRegistry,
	isLoadedPlugin,
	type DatatypeDescription,
	type LoadedDatatype,
} from "@inkandswitch/patchwork-plugins"
import {asString, folderLinks} from "./folders.ts"

/**
 * Put a project at the top of the recent projects list, under its current
 * name. Every older entry for it goes, so two tabs racing to add the same
 * project can't leave it in the list twice.
 */
export function addToRecents(
	recents: DocHandle<FolderDoc>,
	projectUrl: AutomergeUrl,
	name: string
) {
	const links = folderLinks(recents.doc())
	const listed = links.filter(link => link.url === projectUrl)
	if (links[0]?.url === projectUrl && links[0].name === name && listed.length === 1)
		return
	recents.change(doc => {
		if (!Array.isArray(doc.docs)) doc.docs = []
		removeEntries(doc, projectUrl)
		doc.docs.splice(0, 0, {name, type: "folder", url: projectUrl})
	})
}

/** Take a project off the list. The project folder itself is left alone. */
export function removeFromRecents(
	recents: DocHandle<FolderDoc>,
	projectUrl: AutomergeUrl
) {
	recents.change(doc => removeEntries(doc, projectUrl))
}

export async function createWorkspace(repo: Repo, name: string) {
	const datatype = await getRegistry<DatatypeDescription>(
		"patchwork:datatype"
	).load("folder")
	if (!datatype || !isLoadedPlugin(datatype))
		throw new Error("projects: the folder datatype isn't installed")
	const handle = await createDocOfDatatype2(
		datatype as LoadedDatatype<FolderDoc>,
		repo,
		doc => {
			doc.title = name
		}
	)
	return handle.url
}

function removeEntries(doc: FolderDoc, projectUrl: AutomergeUrl) {
	if (!Array.isArray(doc.docs)) return
	for (let index = doc.docs.length - 1; index >= 0; index--) {
		if (asString(doc.docs[index]?.url) === projectUrl) doc.docs.splice(index, 1)
	}
}
