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
	/** a pull request, listed for everyone; false for a preview */
	published: boolean
}

/** The overlay provider's `merge:conflicts`: each member's conflicts, and how each went. */
export type MergeConflicts = Record<
	AutomergeUrl,
	{
		at: unknown
		source: unknown
		target: unknown
		both?: unknown
		state: "open" | "source" | "target" | "both" | "edited"
	}[]
>

/** How many conflicts no one has resolved yet. */
export function openConflicts(conflicts: MergeConflicts | undefined): number {
	let open = 0
	for (const each of Object.values(conflicts ?? {}))
		for (const conflict of each) if (conflict.state === "open") open++
	return open
}

/**
 * The compare provider's `compare`: two versions, A checked out and B
 * compared with; or a merge (A, after) against its target (B, before).
 */
export type Comparison =
	| {kind: "compare"; a: Overlay; b: Overlay}
	| {
			kind: "merge"
			a: AutomergeUrl
			b: Overlay
			source: Overlay
			target: Overlay
			published: boolean
	  }
	| null

/** The merge shown, if the comparison is one, as the header reads it. */
export function mergeShown(comparison: Comparison): MergeEntry | undefined {
	return comparison?.kind === "merge"
		? {
				url: comparison.a,
				source: comparison.source,
				target: comparison.target,
				published: comparison.published,
			}
		: undefined
}

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
