import type {DocHandle} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import type {ToolElement} from "@inkandswitch/patchwork-plugins"
import {createEffect, createSignal, Show} from "solid-js"
import {render} from "solid-js/web"
import {DraftScopeView} from "./drafts.tsx"
import {useDoc, useDocTitle, useHandle} from "./hooks.ts"
import {createNavigation, type DraftScope} from "./navigation.ts"
import {PackagesPage} from "./packages.tsx"
import {ProjectView} from "./project.tsx"
import {Provider} from "./provider.tsx"
import {addToRecents} from "./recents.ts"
import {provideSelection} from "./selection.ts"
import {injectStyles} from "./styles.ts"
import type {AccountDoc} from "./types.ts"
import {SidebarButton, WorkspaceList, type SidebarToggle} from "./workspaces.tsx"

const SIDEBAR_KEY = "gaios-projects:workspaces"

export function renderFrame(handle: DocHandle<AccountDoc>, element: ToolElement) {
	injectStyles()
	const siteTitle = document.title
	return render(
		() => <Frame account={handle} element={element} siteTitle={siteTitle} />,
		element
	)
}

function Frame(props: {
	account: DocHandle<AccountDoc>
	element: ToolElement
	siteTitle: string
}) {
	const repo = props.element.repo
	const navigation = createNavigation(props.element, repo)
	provideSelection(props.element, navigation.selectedView)

	const account = useDoc(() => props.account)
	const recents = useHandle<FolderDoc>(repo, () => account()?.rootFolderUrl)
	// A folder's name is its title; another document's is whatever its
	// datatype calls it.
	const rootTitle = useDocTitle(repo, () => {
		const current = navigation.project()
		return current?.resolved.root === "document" ? current.resolved.projectUrl : undefined
	})
	createEffect(() => {
		const current = navigation.project()
		const list = recents()
		if (!current || !list) return
		const {resolved} = current
		const name =
			resolved.root === "document" ? (rootTitle() ?? resolved.projectName) : resolved.projectName
		addToRecents(list, resolved.projectUrl, name, resolved.rootType)
	})
	createEffect(() => {
		const page = navigation.route().page
		if (page === "home") document.title = props.siteTitle
		if (page === "packages") document.title = `Packages | ${props.siteTitle}`
	})

	const [sidebar, setSidebar] = createSignal(localStorage.getItem(SIDEBAR_KEY) !== "hidden")
	const toggleSidebar = () => {
		const open = !sidebar()
		setSidebar(open)
		localStorage.setItem(SIDEBAR_KEY, open ? "shown" : "hidden")
	}
	const sidebarToggle: SidebarToggle = {
		get open() {
			return sidebar()
		},
		toggle: toggleSidebar,
	}

	// The open project, once it's the one whose drafts are mounted.
	const shown = (scope: DraftScope) => {
		const project = navigation.project()
		const projectRepo = navigation.projectRepo()
		return project?.resolved.projectUrl === scope.projectUrl && projectRepo
			? {project, repo: projectRepo}
			: undefined
	}

	return (
		<Provider component="patchwork-account-provider" docUrl={props.account.url}>
			<Provider
				component="patchwork-tool-storage-provider"
				docUrl={props.account.url}>
				<patchwork-view component="patchwork-worker-provider">
					<div class="projects">
						<Show when={sidebar()}>
							<WorkspaceList
								recents={recents}
								repo={repo}
								current={navigation.scope()?.projectUrl}
								hidden={account()?.moduleSettingsUrl}
								open={url => navigation.open(url)}
								packages={navigation.packages}
							/>
						</Show>
						<Show when={navigation.route().page === "home"}>
							<div class="projects__card projects__card--empty">
								<header class="projects__card-header">
									<SidebarButton sidebar={sidebarToggle} />
								</header>
								<p class="projects__empty">Open a workspace, or make a new one.</p>
							</div>
						</Show>
						<Show when={navigation.route().page === "packages"}>
							<PackagesPage
								url={account()?.moduleSettingsUrl}
								sidebar={sidebarToggle}
							/>
						</Show>
						<Show when={navigation.scope()} keyed>
							{scope => (
								<DraftScopeView scope={scope} attach={navigation.attach}>
									<Show when={shown(scope)}>
										{shown => (
											<ProjectView
												route={shown().project}
												repo={shown().repo}
												siteTitle={props.siteTitle}
												focus={navigation.focus}
												compare={navigation.compare}
												sidebar={sidebarToggle}
											/>
										)}
									</Show>
								</DraftScopeView>
							)}
						</Show>
					</div>
				</patchwork-view>
			</Provider>
		</Provider>
	)
}
