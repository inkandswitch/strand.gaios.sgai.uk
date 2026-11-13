import {request, subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, onCleanup, Show, type JSX} from "solid-js"
import {useMounted} from "./hooks.ts"
import type {DraftProviderElement, DraftScope, Navigation} from "./navigation.ts"
import type {DraftsState} from "./types.ts"

const PROVIDER = "patchwork-draft-provider"

/**
 * A workspace's draft provider, around everything shown of it: the files and
 * the open documents all see the draft it has checked out.
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
		onCleanup(
			subscribe<DraftsState>(provider, {type: "drafts"}, state => setStatus(state.status))
		)
	})

	const openMain = () => {
		const provider = element()
		if (provider)
			void request(provider, {type: "draft:checkout", draft: props.scope.projectUrl})
	}

	return (
		<patchwork-view
			class="projects__scope"
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
