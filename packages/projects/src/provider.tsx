import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {createSignal, Show, type JSX} from "solid-js"
import {useMounted} from "./hooks.ts"

/**
 * A provider `<patchwork-view>` that holds back what's inside it until it has
 * mounted, so nothing subscribes before it's listening.
 */
export function Provider(props: {
	component: string
	docUrl?: AutomergeUrl
	class?: string
	children: JSX.Element
}) {
	const [element, setElement] = createSignal<HTMLElement>()
	const mounted = useMounted(props.component, element)
	return (
		<patchwork-view
			component={props.component}
			doc-url={props.docUrl}
			class={props.class}
			ref={setElement}>
			<Show when={mounted()}>{props.children}</Show>
		</patchwork-view>
	)
}
