import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {request, subscribe} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, on, onCleanup, Show, untrack} from "solid-js"
import {Dock, type Comparing} from "./dock.tsx"
import {WorkspaceHeader} from "./header.tsx"
import {useDocTitle, useMounted} from "./hooks.ts"
import type {ProjectRoute} from "./navigation.ts"
import {Provider} from "./provider.tsx"
import type {CompareAgainst, DraftsState} from "./types.ts"

const COMPARE_PROVIDER = "patchwork-compare-provider"

/**
 * A workspace as a card: its header, its files beside its open documents,
 * all seen through the draft the provider around it has checked out (`repo`
 * is that provider's), and compared with another draft when one's picked.
 */
export function ProjectView(props: {
	route: ProjectRoute
	repo: Repo
	siteTitle: string
	focus(panel: ProjectRoute | undefined): void
	compare(draft: AutomergeUrl | undefined): void
	toggleSidebar(): void
}) {
	const docUrl = () => props.route.resolved.docUrl
	const projectName = () => props.route.resolved.projectName
	const title = useDocTitle(props.repo, docUrl)
	const [root, setRoot] = createSignal<HTMLElement>()
	const [provider, setProvider] = createSignal<HTMLElement>()
	const [card, setCard] = createSignal<HTMLElement>()
	const mounted = useMounted(COMPARE_PROVIDER, provider)
	const [drafts, setDrafts] = createSignal<DraftsState>()
	const [against, setAgainst] = createSignal<CompareAgainst>(null)
	const [heard, setHeard] = createSignal(false)
	const compared = createMemo<AutomergeUrl | undefined>(previous => {
		const current = against()
		return current?.previewing ? previous : current?.draft
	})
	// The draft provider names it by its url, and checks views out of it by
	// that, but main is the draft provider's own `doc-url`.
	const comparing = createMemo<Comparing | undefined>(() => {
		const state = drafts()
		const draft = against()?.draft
		if (!state || !draft) return undefined
		const main = draft === state.main || draft === state.workspace
		const name = state.drafts.find(entry => entry.url === draft)?.name ?? ""
		return {workspace: state.workspace, draft: main ? undefined : draft, name}
	}, undefined, {
		equals: (a, b) =>
			a?.workspace === b?.workspace && a?.draft === b?.draft && a?.name === b?.name,
	})

	createEffect(() => {
		document.title = [title(), projectName(), props.siteTitle]
			.filter(Boolean)
			.join(" | ")
	})

	createEffect(() => {
		const at = card()
		if (!mounted() || !at) return
		onCleanup(subscribe<DraftsState>(at, {type: "drafts"}, state => setDrafts(state)))
		onCleanup(
			subscribe<CompareAgainst>(at, {type: "compare:against"}, value => {
				setAgainst(value)
				setHeard(true)
			})
		)
	})

	// The hash and the provider follow each other, once the provider has
	// started from the hash's.
	createEffect(() => {
		if (heard()) props.compare(compared())
	})
	createEffect(
		on(
			() => props.route.location.compare,
			wanted => {
				const at = card()
				if (!untrack(heard) || !at || wanted === untrack(compared)) return
				void request(at, {type: "compare:set", draft: wanted ?? null})
			},
			{defer: true}
		)
	)

	return (
		<div ref={setRoot} class="projects__project">
			<patchwork-view
				ref={setProvider}
				component={COMPARE_PROVIDER}
				attr:against={props.route.location.compare}
				class="projects__compare-scope">
				<section ref={setCard} class="projects__card">
					<Show when={mounted() && drafts() && card()}>
						{at => (
							<>
								<WorkspaceHeader
									name={projectName()}
									drafts={drafts()}
									against={against()}
									compared={compared()}
									element={at()}
									toggleSidebar={props.toggleSidebar}
								/>
								<div class="projects__body">
									<aside class="projects__files">
										<h2 class="projects__label">Files</h2>
										<patchwork-view
											class="projects__panel"
											tool-id="chee/document-list"
											doc-url={props.route.resolved.projectUrl}
										/>
									</aside>
									<Provider component="patchwork-comments-provider">
										<Provider component="patchwork-focus-provider">
											<main class="projects__main">
												<Dock
													route={props.route}
													repo={props.repo}
													draftKey={drafts()!.checkedOut}
													comparing={comparing()}
													focus={props.focus}
													host={root()}
												/>
											</main>
										</Provider>
									</Provider>
								</div>
							</>
						)}
					</Show>
				</section>
			</patchwork-view>
		</div>
	)
}
