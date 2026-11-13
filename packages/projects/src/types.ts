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

/**
 * The compare provider's `compare:against`. `merging` while the checked-out
 * draft's merge into `draft` is looked over; `after` is the hidden draft
 * showing what the merge leaves it as, once it's made.
 */
export type CompareAgainst = {
	draft: AutomergeUrl
	previewing: boolean
	merging: boolean
	after: AutomergeUrl | null
} | null

/**
 * How a file differs: compared, on both drafts and different, or only on
 * ours or theirs; merging, what the merge does to the target's.
 */
export type Mark = "differs" | "ours" | "theirs" | "added" | "removed" | "changed" | "both"

/** The compare provider's `compare:changes`: what differs, by file and folder. */
export type CompareChanges = {
	status: "off" | "loading" | "ready"
	mode: "compare" | "merge"
	files: Record<AutomergeUrl, Mark>
	folders: Record<AutomergeUrl, Mark>
}
