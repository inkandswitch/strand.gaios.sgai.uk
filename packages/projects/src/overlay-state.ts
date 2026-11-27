import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, onCleanup, type Accessor} from "solid-js"
import type {Versions} from "./compare.ts"
import type {Comparing} from "./panel.tsx"
import {historyShown, overlayName, type Comparison, type OverlaysState} from "./types.ts"

/**
 * What the providers around `element` say about the root (`root`): its
 * overlays, the two versions compared, and that comparison as the panels
 * read it. Read by the frame, for the header, and by a root's tool, for its
 * panels, once `ready` (the providers are listening).
 */
export function useOverlayState(
	element: Accessor<HTMLElement | undefined>,
	ready: Accessor<boolean>,
	root: Accessor<AutomergeUrl>
) {
	const [overlays, setOverlays] = createSignal<OverlaysState>()
	const [comparison, setComparison] = createSignal<Comparison>(null)
	const [heard, setHeard] = createSignal(false)

	createEffect(() => {
		const at = element()
		if (!ready() || !at) return
		onCleanup(subscribe<OverlaysState>(at, {type: "overlays"}, state => setOverlays(state)))
		onCleanup(
			subscribe<Comparison>(at, {type: "compare"}, value => {
				setComparison(value)
				setHeard(true)
			})
		)
	})

	const comparing = createMemo<Comparing | undefined>(
		() => {
			const state = overlays()
			const current = comparison()
			if (!state || !current) return undefined
			return {
				root: root(),
				a: current.a,
				aAt: current.kind === "compare" ? current.aAt : null,
				b: current.b,
				bAt: current.kind === "compare" ? current.bAt : null,
				names: {a: overlayName(state, current.a), b: overlayName(state, current.b)},
				// Two points in one history read before to after, like a merge.
				merging: current.kind === "merge" || historyShown(current),
			}
		},
		undefined,
		{
			equals: (a, b) =>
				a?.root === b?.root &&
				a?.a === b?.a &&
				a?.aAt === b?.aAt &&
				a?.b === b?.b &&
				a?.bAt === b?.bAt &&
				a?.names.a === b?.names.a &&
				a?.names.b === b?.names.b &&
				a?.merging === b?.merging,
		}
	)

	/**
	 * What the two versions are called, each in its own colour. A merge reads
	 * before to after, in no version's colour: then `a` is before, the target.
	 */
	const versions = createMemo<Versions | undefined>(() => {
		const current = comparing()
		if (!current) return undefined
		if (current.merging)
			return {
				a: {name: `Before · ${current.names.b}`, color: "var(--compare-neutral)"},
				b: {name: "After", color: "var(--compare-neutral)"},
			}
		return {
			a: {name: current.names.a, color: "var(--compare-a)"},
			b: {name: current.names.b, color: "var(--compare-b)"},
		}
	})

	return {overlays, comparison, heard, comparing, versions}
}
