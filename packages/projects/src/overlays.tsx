import {request, subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, onCleanup, Show, type JSX} from "solid-js"
import {useMounted} from "./hooks.ts"
import type {Navigation, OverlayProviderElement, OverlayScope} from "./navigation.ts"
import type {OverlaysState} from "./types.ts"

const PROVIDER = "patchwork-overlay-provider"

/**
 * A project's overlay provider, around everything shown of it: the files and
 * the open documents all see the overlay it has checked out.
 */
export function OverlayScopeView(props: {
	scope: OverlayScope
	attach: Navigation["attach"]
	children: JSX.Element
}) {
	const [element, setElement] = createSignal<OverlayProviderElement>()
	const mounted = useMounted(PROVIDER, element)
	const [status, setStatus] = createSignal<string>()

	createEffect(() => {
		const provider = element()
		if (!mounted() || !provider) return
		onCleanup(props.attach(props.scope.projectUrl, provider))
		onCleanup(
			subscribe<OverlaysState>(provider, {type: "overlays"}, state => setStatus(state.status))
		)
	})

	const openMain = () => {
		const provider = element()
		if (provider) void request(provider, {type: "overlay:checkout", overlay: null})
	}

	return (
		<patchwork-view
			class="projects__scope"
			component={PROVIDER}
			doc-url={props.scope.projectUrl}
			attr:overlay={props.scope.overlay}
			attr:at={props.scope.at}
			ref={setElement}>
			<Show when={status() === "unavailable"}>
				<div class="projects__unavailable" role="alert">
					<p>This draft isn't available. It may have been deleted, or not synced here yet.</p>
					<button type="button" class="projects__button" onClick={openMain}>
						Open main
					</button>
				</div>
			</Show>
			<Show when={mounted()}>{props.children}</Show>
		</patchwork-view>
	)
}

/**
 * The project with `overlay` checked out (main when null), at `at` in its
 * history if that's set, for the views inside.
 */
export function OtherOverlay(props: {
	root: string
	overlay: string | null
	at?: string | null
	children: JSX.Element
}) {
	const [element, setElement] = createSignal<HTMLElement>()
	const mounted = useMounted(PROVIDER, element)
	return (
		<patchwork-view
			ref={setElement}
			class="projects__other-draft"
			component={PROVIDER}
			doc-url={props.root}
			attr:overlay={props.overlay ?? undefined}
			attr:at={props.at ?? undefined}>
			<Show when={mounted()}>{props.children}</Show>
		</patchwork-view>
	)
}
