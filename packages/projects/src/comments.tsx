import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import {accept, subscribe, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, onCleanup, Show, type Accessor, type JSX} from "solid-js"
import type {ProjectRoute} from "./navigation.ts"
import {Provider} from "./provider.tsx"
import type {SidePanels} from "./side-panels.ts"

/** The comments sidebar's component (packages/comments). */
const SIDEBAR = "gaios-comments"

/*
 * The frame and the comments sidebar talk with plain data:
 *
 *   - `comments:context` → the project, the documents visible in it (a
 *     folder's being everything beneath it) and those shown in views, the
 *     drafts' names and which threads to list: all of them while the whole
 *     project is visible, else those on what's visible; pushed on every
 *     change (see packages/comments/context.ts)
 *   - `comments:create { refs }` → from any tool: start a thread about
 *     `refs` in the project's root document, where every thread is kept,
 *     with a draft comment by whoever's signed in, and show it in the
 *     sidebar; answers the thread's url, or null
 *   - a `patchwork:show-comments { threadUrl }` event, bubbling from a tool,
 *     opens the sidebar on that thread
 */

type Context = {
	projectUrl: AutomergeUrl
	projectId: string
	projectName: string
	root: "folder" | "document"
	/** what's visible, a folder as everything beneath it */
	openDocs: AutomergeUrl[]
	/** the documents shown in views */
	viewed: AutomergeUrl[]
	ours: string | null
	theirs: string | null
	/** the threads to list: on what's visible, or all of them */
	scope: "open" | "all"
	/** the thread a tool last asked to show, with a count so asking again is told apart */
	active: {threadUrl: AutomergeUrl; count: number} | null
}

type ThreadsDoc = {
	"@comments"?: {
		threads: {
			id: string
			refs: AutomergeUrl[]
			isResolved: boolean
			comments: {id: string; contactUrl: AutomergeUrl; timestamp: number}[]
			"@patchwork": {type: string}
		}[]
	}
}

/**
 * The card with the root on it, and the column beside it with the history
 * and the comments, under one comments provider and one focus provider, so
 * the comments and every open document's tool share what's selected and
 * highlighted. The column is folded away while neither is shown.
 */
export function CommentsScope(props: {
	route: ProjectRoute
	/** the checked-out draft's repo, where the root is found */
	repo: Repo
	ours: string | undefined
	theirs: string | undefined
	panels: SidePanels
	/** what's visible, a folder as everything beneath it; `whole` when that's the project */
	visible: {whole: boolean; docs: AutomergeUrl[]}
	/** what the history covers, when that's less than the project */
	covering: string | undefined
	history: JSX.Element
	children: JSX.Element
}) {
	const [scope, setScope] = createSignal<HTMLElement>()
	const viewed = useViewedDocs(scope)
	const [active, setActive] = createSignal<Context["active"]>(null)
	let shown = 0
	const showThread = (threadUrl: AutomergeUrl | undefined) => {
		props.panels.showComments()
		if (threadUrl) setActive({threadUrl, count: ++shown})
	}
	const [contact, setContact] = createSignal<AutomergeUrl>()
	createEffect(() => {
		const element = scope()
		if (element)
			onCleanup(
				subscribe<AutomergeUrl>(element, {type: "patchwork:contact"}, url => setContact(() => url))
			)
	})

	// Every thread in the project is kept in its root document.
	const create = async (refs: AutomergeUrl[]): Promise<AutomergeUrl | null> => {
		const contactUrl = contact()
		if (!contactUrl || refs.length === 0) return null
		const root = await props.repo
			.find<ThreadsDoc>(props.route.resolved.projectUrl)
			.catch(() => undefined)
		if (!root || root.isReadOnly?.()) return null
		const id = crypto.randomUUID()
		root.change(doc => {
			doc["@comments"] ??= {threads: []}
			doc["@comments"].threads.push({
				id,
				refs: [...refs],
				isResolved: false,
				comments: [{id: crypto.randomUUID(), contactUrl, timestamp: Date.now()}],
				"@patchwork": {type: "comment-thread"},
			})
		})
		const threadUrl = (root as DocHandle<unknown>).sub("@comments", "threads", {id})
			.url as AutomergeUrl
		showThread(threadUrl)
		return threadUrl
	}

	const context = createMemo<Context>(() => ({
		projectUrl: props.route.resolved.projectUrl,
		projectId: props.route.location.projectId,
		projectName: props.route.resolved.projectName,
		root: props.route.resolved.root === "folder" ? "folder" : "document",
		openDocs: props.visible.docs,
		// a view in a tab behind another stays counted, but isn't visible
		viewed: viewed().filter(url => props.visible.docs.includes(url)),
		ours: props.ours ?? null,
		theirs: props.theirs ?? null,
		scope: props.visible.whole ? "all" : "open",
		active: active(),
	}))

	createEffect(() => {
		const element = scope()
		if (!element) return
		const listeners = new Set<(value: Context) => void>()
		const onSubscribe = (event: SubscribeEvent) => {
			const selector = event.detail.selector as {type: string; refs?: unknown}
			if (selector.type === "comments:context") {
				accept<Context>(event, respond => {
					respond(context())
					listeners.add(respond)
					return () => listeners.delete(respond)
				})
			} else if (selector.type === "comments:create") {
				const refs = Array.isArray(selector.refs)
					? (selector.refs.filter(ref => typeof ref === "string") as AutomergeUrl[])
					: []
				accept<AutomergeUrl | null>(event, respond => {
					create(refs).then(respond, error => {
						console.error("projects: couldn't start a comment thread", error)
						respond(null)
					})
				})
			}
		}
		const onShow = (event: Event) =>
			showThread((event as CustomEvent<{threadUrl?: AutomergeUrl}>).detail?.threadUrl)
		element.addEventListener("patchwork:subscribe", onSubscribe as EventListener)
		element.addEventListener("patchwork:show-comments", onShow)
		createEffect(() => {
			const value = context()
			for (const respond of listeners) respond(value)
		})
		onCleanup(() => {
			element.removeEventListener("patchwork:subscribe", onSubscribe as EventListener)
			element.removeEventListener("patchwork:show-comments", onShow)
			listeners.clear()
		})
	})

	return (
		<Provider component="patchwork-comments-provider" class="projects__provider">
			<Provider component="patchwork-focus-provider" class="projects__provider">
				<div ref={setScope} class="projects__stage">
					<section class="projects__card">{props.children}</section>
					<div
						class="projects__side"
						hidden={!props.panels.history() && !props.panels.comments()}>
						<Show when={props.panels.history()}>
							<section class="projects__side-section projects__side-section--history" aria-label="History">
								<h2 class="projects__side-title">
									History
									<Show when={props.covering}>
										{covering => <span class="projects__side-covering"> · {covering()}</span>}
									</Show>
								</h2>
								{props.history}
							</section>
						</Show>
						{/* kept mounted while hidden, so it's ready when shown */}
						<section
							class="projects__side-section projects__side-section--comments"
							aria-label="Comments"
							hidden={!props.panels.comments()}>
							<h2 class="projects__side-title">Comments</h2>
							<patchwork-view class="projects__comments-view" component={SIDEBAR} />
						</section>
					</div>
				</div>
			</Provider>
		</Provider>
	)
}

/**
 * The documents shown in views in the dock (or the root shown on its own):
 * the outermost documents mounted in `.projects__main`, in the order they
 * opened. What they embed, and the tree and the sidebar, don't count.
 */
function useViewedDocs(scope: Accessor<HTMLElement | undefined>): Accessor<AutomergeUrl[]> {
	const [docs, setDocs] = createSignal<AutomergeUrl[]>([])
	createEffect(() => {
		const element = scope()
		if (!element) return
		const counts = new Map<AutomergeUrl, number>()
		const publish = () => {
			const next = [...counts.keys()]
			setDocs(previous =>
				previous.length === next.length && previous.every((u, i) => u === next[i])
					? previous
					: next
			)
		}
		const opened = (event: Event) => {
			const url = openDocOf(event)
			if (!url) return
			counts.set(url, (counts.get(url) ?? 0) + 1)
			publish()
		}
		const closed = (event: Event) => {
			const url = openDocOf(event)
			if (!url) return
			const n = (counts.get(url) ?? 0) - 1
			if (n > 0) counts.set(url, n)
			else counts.delete(url)
			publish()
		}
		element.addEventListener("patchwork:mounted", opened)
		element.addEventListener("patchwork:unmounted", closed)
		onCleanup(() => {
			element.removeEventListener("patchwork:mounted", opened)
			element.removeEventListener("patchwork:unmounted", closed)
		})
	})
	return docs
}

function openDocOf(event: Event): AutomergeUrl | undefined {
	const detail = (event as CustomEvent<{url?: AutomergeUrl}>).detail
	const url = detail?.url
	if (!url || url.includes("/") || url.includes("#")) return undefined
	const view = event.composedPath()[0]
	if (!(view instanceof Element)) return undefined
	const main = view.closest(".projects__main")
	if (!main) return undefined
	const outer = view.parentElement?.closest("patchwork-view[doc-url]")
	if (outer && main.contains(outer)) return undefined
	return url
}
