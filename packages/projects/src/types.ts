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

/** A draft or a merge by its url, or null for main. */
export type Overlay = AutomergeUrl | null

/** The overlay provider's `overlays`. */
export type OverlaysState = {
	checkedOut: Overlay
	status: "loading" | "ready" | "unavailable"
	drafts: DraftEntry[]
	merges: MergeEntry[]
}

export type DraftEntry = {
	url: AutomergeUrl
	name: string
	/** the nearest listed draft it was forked off; null for main */
	parent: AutomergeUrl | null
}

export type MergeEntry = {
	url: AutomergeUrl
	source: AutomergeUrl | null
	target: AutomergeUrl | null
}

/** The compare provider's `compare`: A checked out, B compared with. */
export type Comparison = {a: Overlay; b: Overlay} | null

/** One member of the root, as an overlay has it: the overlay provider's `overlay:members`. */
export type Member = {
	url: AutomergeUrl
	heads: string[]
	parent: AutomergeUrl | null
}

/** What an overlay is called: main, a draft's name, or a merge's two sides. */
export function overlayName(state: OverlaysState | undefined, overlay: Overlay): string {
	if (overlay === null) return "Main"
	const draft = state?.drafts.find(entry => entry.url === overlay)
	if (draft) return draft.name
	const merge = state?.merges.find(entry => entry.url === overlay)
	if (merge) return `${overlayName(state, merge.source)} → ${overlayName(state, merge.target)}`
	return ""
}

/** The listed merge `overlay` is, if it's one. */
export function mergeOf(state: OverlaysState | undefined, overlay: Overlay) {
	return overlay === null ? undefined : state?.merges.find(entry => entry.url === overlay)
}
