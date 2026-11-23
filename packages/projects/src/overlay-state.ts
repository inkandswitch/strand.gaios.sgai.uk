import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, onCleanup, type Accessor} from "solid-js"
import type {Versions} from "./compare.ts"
import type {Comparing} from "./panel.tsx"
import {overlayName, type Comparison, type OverlaysState} from "./types.ts"

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
				b: current.b,
				names: {a: overlayName(state, current.a), b: overlayName(state, current.b)},
			}
		},
		undefined,
		{
			equals: (a, b) =>
				a?.root === b?.root &&
				a?.b === b?.b &&
				a?.names.a === b?.names.a &&
				a?.names.b === b?.names.b,
		}
	)

	/** What the two versions are called, each in its own colour. */
	const versions = createMemo<Versions | undefined>(() => {
		const current = comparing()
		return (
			current && {
				a: {name: current.names.a, color: "var(--compare-a)"},
				b: {name: current.names.b, color: "var(--compare-b)"},
			}
		)
	})

	return {overlays, comparison, heard, comparing, versions}
}
