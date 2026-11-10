import {request, subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, onCleanup, Show, type JSX} from "solid-js"
import {useMounted} from "./hooks.ts"
import type {DraftProviderElement, DraftScope, Navigation} from "./navigation.ts"

const PROVIDER = "patchwork-draft-provider"

/**
 * A project's draft provider, around everything shown of the project: the
 * tree and the open document both see the draft it has checked out.
 */
export function DraftScopeView(props: {
	scope: DraftScope
	attach: Navigation["attach"]
	children: JSX.Element
}) {
	const [element, setElement] = createSignal<DraftProviderElement>()
	const mounted = useMounted(PROVIDER, element)
	const [status, setStatus] = createSignal<string>()

	createEffect(() => {
		const provider = element()
		if (!mounted() || !provider) return
		onCleanup(props.attach(props.scope.projectUrl, provider))
		onCleanup(subscribe<string>(provider, {type: "draft:status"}, setStatus))
	})

	const openMain = () => {
		const provider = element()
		if (provider)
			void request(provider, {type: "draft:select", checkedOut: null, at: null})
	}

	return (
		<patchwork-view
			component={PROVIDER}
			doc-url={props.scope.projectUrl}
			attr:draft={props.scope.draft}
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
