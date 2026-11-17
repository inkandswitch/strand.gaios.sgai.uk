import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {SidebarButton, type SidebarToggle} from "./workspaces.tsx"

/** where the site keeps the account's url: `accountKey` in src/main.ts */
const ACCOUNT_KEY = "gaiosAccountUrl"

/**
 * The account, through the account package's `account-picker`: who's signed
 * in, signing up, in and out. It signs in and out under the key the site's
 * setup keeps the account in.
 */
export function AccountPage(props: {
	url: AutomergeUrl
	/** the sidebar, shown or hidden from the card header */
	sidebar: SidebarToggle
}) {
	return (
		<div class="projects__card">
			<header class="projects__card-header">
				<SidebarButton sidebar={props.sidebar} />
				<h1 class="projects__workspace-title">Account</h1>
			</header>
			<patchwork-view
				class="projects__account-view"
				doc-url={props.url}
				tool-id="account-picker"
				attr:account-key={ACCOUNT_KEY}
			/>
		</div>
	)
}
