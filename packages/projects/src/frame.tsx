import type {DocHandle} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import type {ToolElement} from "@inkandswitch/patchwork-plugins"
import {createEffect, Show} from "solid-js"
import {render} from "solid-js/web"
import {DraftScopeView} from "./drafts.tsx"
import {useDoc, useHandle} from "./hooks.ts"
import {createNavigation, type DraftScope} from "./navigation.ts"
import {ProjectView} from "./project.tsx"
import {Provider} from "./provider.tsx"
import {addToRecents} from "./recents.ts"
import {provideSelection} from "./selection.ts"
import {Splash} from "./splash.tsx"
import styles from "./styles.css?inline"
import type {AccountDoc} from "./types.ts"

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
	createEffect(() => {
		const current = navigation.project()
		const list = recents()
		if (current && list)
			addToRecents(
				list,
				current.resolved.projectUrl,
				current.resolved.projectName
			)
	})
	createEffect(() => {
		if (navigation.route().page === "splash") document.title = props.siteTitle
	})

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
						<Show when={navigation.route().page === "splash"}>
							<Splash
								recents={recents}
								repo={repo}
								open={url => navigation.open(url)}
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
												home={navigation.home}
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

function injectStyles() {
	const id = "gaios-projects-styles"
	const existing = document.getElementById(id)
	if (existing) {
		existing.textContent = styles
		return
	}
	const style = document.createElement("style")
	style.id = id
	style.textContent = styles
	document.head.append(style)
}
