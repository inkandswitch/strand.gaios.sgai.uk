import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {Show} from "solid-js"
import {SidebarButton, type SidebarToggle} from "./workspaces.tsx"

/**
 * The account's packages, through the `packages` tool: what's installed,
 * and installing more tools and datatypes.
 */
export function PackagesPage(props: {
	/** the account's module settings, where its packages are listed */
	url: AutomergeUrl | undefined
	/** the sidebar, shown or hidden from the card header */
	sidebar: SidebarToggle
}) {
	return (
		<div class="projects__card">
			<header class="projects__card-header">
				<SidebarButton sidebar={props.sidebar} />
				<h1 class="projects__workspace-title">Packages</h1>
			</header>
			<Show
				when={props.url}
				fallback={
					<p class="projects__empty">This account has no package settings yet.</p>
				}>
				{url => (
					<patchwork-view class="projects__packages-view" doc-url={url()} tool-id="packages" />
				)}
			</Show>
		</div>
	)
}
