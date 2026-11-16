import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, onCleanup, type Accessor} from "solid-js"
import type {Comparing} from "./panel.tsx"
import type {CompareAgainst, DraftsState} from "./types.ts"

/**
 * What the providers around `element` say about the root: its drafts, the
 * draft it's compared with or merged into, and that comparison as the panels
 * read it. Read by the frame, for the header, and by a root's tool, for its
 * panels, once `ready` (the providers are listening).
 */
export function useWorkspaceState(
	element: Accessor<HTMLElement | undefined>,
	ready: Accessor<boolean>
) {
	const [drafts, setDrafts] = createSignal<DraftsState>()
	const [against, setAgainst] = createSignal<CompareAgainst>(null)
	const [heard, setHeard] = createSignal(false)

	createEffect(() => {
		const at = element()
		if (!ready() || !at) return
		onCleanup(subscribe<DraftsState>(at, {type: "drafts"}, state => setDrafts(state)))
		onCleanup(
			subscribe<CompareAgainst>(at, {type: "compare:against"}, value => {
				setAgainst(value)
				setHeard(true)
			})
		)
	})

	// The draft provider names it by its url, and checks views out of it by
	// that, but main is the draft provider's own `doc-url`.
	const comparing = createMemo<Comparing | undefined>(
		() => {
			const state = drafts()
			const current = against()
			const draft = current?.draft
			if (!state || !draft) return undefined
			// main comes first, under the workspace's url or the main draft's
			const isMain = (url: AutomergeUrl) => url === state.main || url === state.workspace
			const nameOf = (url: AutomergeUrl) =>
				(isMain(url) ? state.drafts[0] : state.drafts.find(entry => entry.url === url))?.name ?? ""
			const main = isMain(draft)
			return {
				workspace: state.workspace,
				draft: main ? undefined : draft,
				name: nameOf(draft),
				ours: nameOf(state.checkedOut),
				merging: !!current.merging,
				after: current.after ?? undefined,
			}
		},
		undefined,
		{
			equals: (a, b) =>
				a?.workspace === b?.workspace &&
				a?.draft === b?.draft &&
				a?.name === b?.name &&
				a?.ours === b?.ours &&
				a?.merging === b?.merging &&
				a?.after === b?.after,
		}
	)

	return {drafts, against, heard, comparing}
}
