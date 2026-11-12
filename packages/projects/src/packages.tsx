import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {Show} from "solid-js"
import {BackIcon} from "./project.tsx"

/**
 * The account's packages, through the `packages` tool: what's installed,
 * and installing more tools and datatypes.
 */
export function PackagesPage(props: {
	/** the account's module settings, where its packages are listed */
	url: AutomergeUrl | undefined
	home(): void
}) {
	return (
		<div class="projects__packages">
			<header class="projects__packages-header">
				<button
					type="button"
					class="projects__home"
					title="All projects"
					aria-label="All projects"
					onClick={() => props.home()}>
					<BackIcon />
				</button>
				<h1 class="projects__project-name">Packages</h1>
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
