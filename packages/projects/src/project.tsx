import type {Repo} from "@automerge/automerge-repo/slim"
import {createEffect, createSignal, For, Show} from "solid-js"
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

type Panel = "files" | "review"

const PANELS: {id: Panel; label: string}[] = [
	{id: "files", label: "Files"},
	{id: "review", label: "Review"},
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
	// Both panels stay mounted once shown, so switching back keeps their state;
	// the review only starts working things out once it's first opened.
	const [tab, setTab] = createSignal<Panel>("files")
	const [reviewOpened, setReviewOpened] = createSignal(false)
	const openTab = (panel: Panel) => {
		if (panel === "review") setReviewOpened(true)
		setTab(panel)
	}
	createEffect(() => {
		document.title = [title(), projectName(), props.siteTitle]
			.filter(Boolean)
			.join(" | ")
	})

	return (
		<div class="projects__project">
			<aside class="projects__sidebar">
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
					<patchwork-view component="draft-picker" />
				</header>
				<div class="projects__tabs" role="tablist">
					<For each={PANELS}>
						{panel => (
							<button
								type="button"
								role="tab"
								class="projects__tab"
								aria-selected={tab() === panel.id}
								onClick={() => openTab(panel.id)}>
								{panel.label}
							</button>
						)}
					</For>
				</div>
				<patchwork-view
					class="projects__panel"
					classList={{"projects__panel--hidden": tab() !== "files"}}
					tool-id="chee/document-list"
					doc-url={props.route.resolved.projectUrl}
				/>
				<Show when={reviewOpened()}>
					<patchwork-view
						class="projects__panel"
						classList={{"projects__panel--hidden": tab() !== "review"}}
						tool-id="review"
						doc-url={props.route.resolved.projectUrl}
					/>
				</Show>
			</aside>
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
