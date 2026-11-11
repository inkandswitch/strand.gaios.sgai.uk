import type {Repo} from "@automerge/automerge-repo/slim"
import {createEffect, createSignal} from "solid-js"
import {Dock} from "./dock.tsx"
import {DraftStack, stripsWidth, useDraftLanes} from "./draft-stack.tsx"
import {useDocTitle} from "./hooks.ts"
import type {ProjectRoute} from "./navigation.ts"
import {Provider} from "./provider.tsx"

/**
 * A project's folder tree beside its open documents, all seen through the
 * draft the provider around it has checked out: `repo` is that provider's.
 */
export function ProjectView(props: {
	route: ProjectRoute
	repo: Repo
	siteTitle: string
	focus(panel: ProjectRoute | undefined): void
	home(): void
}) {
	const docUrl = () => props.route.resolved.docUrl
	const projectName = () => props.route.resolved.projectName
	const draftKey = (): string => props.route.location.draft ?? "main"
	const title = useDocTitle(props.repo, docUrl)
	const [root, setRoot] = createSignal<HTMLElement>()
	const [sidebar, setSidebar] = createSignal<HTMLElement>()
	const lanes = useDraftLanes(sidebar)
	createEffect(() => {
		document.title = [title(), projectName(), props.siteTitle]
			.filter(Boolean)
			.join(" | ")
	})

	return (
		<div ref={setRoot} class="projects__project">
			<Provider component="patchwork-review-provider">
				<aside
					ref={setSidebar}
					class="projects__sidebar"
					style={{"--projects-strips-width": stripsWidth(lanes())}}>
					<header class="projects__sidebar-header">
						<button
							type="button"
							class="projects__home"
							title="All projects"
							aria-label="All projects"
							onClick={() => props.home()}>
							<BackIcon />
						</button>
						<h1 class="projects__project-name">{projectName()}</h1>
					</header>
					<DraftStack element={sidebar} lanes={lanes()}>
						<patchwork-view
							class="projects__panel"
							tool-id="chee/document-list"
							doc-url={props.route.resolved.projectUrl}
						/>
					</DraftStack>
				</aside>
			</Provider>
			<Provider component="patchwork-comments-provider">
				<Provider component="patchwork-focus-provider">
					<main class="projects__main">
						<Dock
							route={props.route}
							repo={props.repo}
							draftKey={draftKey()}
							focus={props.focus}
							host={root()}
						/>
					</main>
				</Provider>
			</Provider>
		</div>
	)
}

// lucide `arrow-left`
function BackIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round">
			<path d="m12 19-7-7 7-7" />
			<path d="M19 12H5" />
		</svg>
	)
}
