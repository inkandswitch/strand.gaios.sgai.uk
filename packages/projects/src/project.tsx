import type {Repo} from "@automerge/automerge-repo/slim"
import {createEffect, createSignal, For, Show} from "solid-js"
import {DraftStack, stripsWidth, useDraftLanes} from "./draft-stack.tsx"
import {useDocTitle} from "./hooks.ts"
import type {ProjectRoute} from "./navigation.ts"
import {Provider} from "./provider.tsx"

/** Each has to be installed: a tool `<patchwork-view>` can't find shows an error. */
const TITLEBAR_TOOLS = [
	"doc-openwith",
	"doc-presence",
	"sync-indicator",
	"theme-titlebar",
]

/**
 * A project's folder tree beside the open document, both seen through the
 * draft the provider around it has checked out: `repo` is that provider's.
 */
export function ProjectView(props: {
	route: ProjectRoute
	repo: Repo
	siteTitle: string
	home(): void
}) {
	const docUrl = () => props.route.resolved.docUrl
	const projectName = () => props.route.resolved.projectName
	const draftKey = (): string => props.route.location.draft ?? "main"
	const title = useDocTitle(props.repo, docUrl)
	const [sidebar, setSidebar] = createSignal<HTMLElement>()
	const lanes = useDraftLanes(sidebar)
	createEffect(() => {
		document.title = [title(), projectName(), props.siteTitle]
			.filter(Boolean)
			.join(" | ")
	})

	return (
		<div class="projects__project">
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
						<Show
							when={docUrl()}
							fallback={
								<p class="projects__empty">
									Open something from the project, or make something new.
								</p>
							}>
							{url => (
								// Most tools keep showing what they first read when their
								// handle moves onto another draft's copy, so each draft
								// gets views of its own.
								<Show when={draftKey()} keyed>
									{_draft => (
										<>
											<header class="projects__titlebar">
												<span class="projects__title">{title() ?? ""}</span>
												<div class="projects__titlebar-tools">
													<For each={TITLEBAR_TOOLS}>
														{toolId => (
															<patchwork-view tool-id={toolId} doc-url={url()} />
														)}
													</For>
												</div>
											</header>
											<patchwork-view
												class="projects__document"
												doc-url={url()}
												tool-id={props.route.location.toolId}
											/>
										</>
									)}
								</Show>
							)}
						</Show>
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
