import type {AutomergeUrl} from "@automerge/automerge-repo/slim"

/**
 * The slice of the account doc the frame uses. `rootFolderUrl` is the
 * workspace list: a folder whose entries point at workspace folders, most
 * recently opened first.
 */
export type AccountDoc = {
	frameToolId?: string
	rootFolderUrl?: AutomergeUrl
	contactUrl?: AutomergeUrl
	/** the packages installed on the account */
	moduleSettingsUrl?: AutomergeUrl
}

/** The draft provider's `drafts` state, as the frame reads it. */
export type DraftsState = {
	workspace: AutomergeUrl
	/** main's url: the main draft's, or the workspace's before it has one */
	main: AutomergeUrl
	checkedOut: AutomergeUrl
	status: "verifying" | "ready" | "unavailable"
	/** main first, then every draft beneath the one it was forked off */
	drafts: DraftEntry[]
}

export type DraftEntry = {
	url: AutomergeUrl
	name: string
	parent: AutomergeUrl | null
	depth: number
}

/** The compare provider's `compare:against`. */
export type CompareAgainst = {draft: AutomergeUrl; previewing: boolean} | null
