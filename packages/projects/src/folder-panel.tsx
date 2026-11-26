import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import {request, type Selector} from "@inkandswitch/patchwork-providers"
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	untrack,
	type Accessor,
} from "solid-js"
import type {Versions} from "./compare.ts"
import {folderLinks, segmentFor, type Link} from "./folders.ts"
import {useDoc, useHandle, useMembers} from "./hooks.ts"
import {short, useHistory, useNow} from "./history.tsx"
import {formatLocationUrl} from "./location.ts"
import {documentOf, foldersToRead, lastEdited, review, type Section} from "./members.ts"
import type {ProjectRoute} from "./navigation.ts"
import {
	Compared,
	PanelCompareControls,
	createPanelState,
	type Comparing,
	type PanelModes,
	type PanelState,
} from "./panel.tsx"
import type {OverlaysState} from "./types.ts"

/** How tall a document under review is drawn, to begin with. */
const SECTION_HEIGHT = "24rem"

/** How far outside the view a document under review starts to be drawn. */
const NEAR = "600px 0px"

type FolderPanelProps = {
	url: AutomergeUrl
	route: ProjectRoute
	repo: Repo
	/** inside the overlay provider, where subscriptions go from */
	host: HTMLElement
	overlays: OverlaysState
	/** opens a location in the project, from this panel */
	open(url: AutomergeUrl): void
	/** opens a location in the project in a tab of its own */
	openTab(url: AutomergeUrl): void
	comparing: Comparing | undefined
	/** the compare modes the dock's panels share */
	modes: PanelModes
	versions: Versions | undefined
	/** the documents under review, for the dock's compare modes */
	setSections(sections: PanelState[]): void
}

/**
 * A folder open in a panel. Not comparing, its own entries; comparing, a
 * review of every document beneath it that differs between the two
 * versions.
 */
export function FolderPanel(props: FolderPanelProps) {
	const key = () => {
		const current = props.comparing
		return current && `${current.a ?? "main"}@${current.aAt ?? ""}|${current.b ?? "main"}@${current.bAt ?? ""}`
	}
	return (
		<Show when={key()} keyed fallback={<Listing {...props} />}>
			{_comparison => <Review {...props} comparing={props.comparing!} />}
		</Show>
	)
}

/**
 * A folder's own entries, folders first, each with when it was last edited,
 * read through the panel's repo, so it follows the checked-out overlay and
 * the point in its history. A row opens its entry.
 */
function Listing(props: FolderPanelProps) {
	const doc = useDoc(useHandle<unknown>(props.repo, () => props.url))
	const links = createMemo(() => folderLinks(doc()))
	const entries = createMemo(() => {
		const all = links()
		return [...all.filter(link => link.type === "folder"), ...all.filter(link => link.type !== "folder")]
	})
	const edited = useLastEdited(() => props.host, () => props.overlays)
	const now = useNow()

	// Where an entry is, one segment below this folder.
	const locationOf = (link: Link) =>
		formatLocationUrl({
			projectId: props.route.location.projectId,
			segments: [...props.route.resolved.trail.map(step => step.segment), segmentFor(link, links())],
		}) as AutomergeUrl

	return (
		<div class="projects__listing" role="table" aria-label="Files">
			<div class="projects__listing-row projects__listing-row--head" role="row">
				<span class="projects__listing-name" role="columnheader">
					Name
				</span>
				<span class="projects__listing-time" role="columnheader">
					Last edited
				</span>
			</div>
			<For each={entries()}>
				{link => {
					const time = () => edited().get(documentOf(link.url))
					return (
						<button
							type="button"
							class="projects__listing-row"
							role="row"
							onClick={() => props.open(locationOf(link))}>
							<span class="projects__listing-name" role="cell">
								<Show when={link.type === "folder"} fallback={<FileIcon />}>
									<FolderIcon />
								</Show>
								<span class="projects__listing-label">{link.name}</span>
							</span>
							<span class="projects__listing-time" role="cell">
								{time() === undefined ? "" : short(time()!, now())}
							</span>
						</button>
					)
				}}
			</For>
		</div>
	)
}

/**
 * When each member of the checked-out overlay was last edited, by document,
 * as of the point it's checked out at.
 */
function useLastEdited(
	host: Accessor<HTMLElement>,
	overlays: Accessor<OverlaysState>
): Accessor<Map<string, number>> {
	const checkedOut = createMemo(() => overlays().checkedOut)
	const at = createMemo(() => overlays().at)
	const entries = useHistory(host, checkedOut)
	const members = useMembers(host, () => ({overlay: checkedOut(), at: at()}))
	return createMemo(() => lastEdited(entries() ?? [], members() ?? [], at()))
}

// lucide `folder`
export function FolderIcon() {
	return (
		<svg
			class="projects__listing-icon"
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		</svg>
	)
}

// lucide `file`
function FileIcon() {
	return (
		<svg
			class="projects__listing-icon"
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		</svg>
	)
}

/**
 * Every document beneath the folder that differs between the two versions,
 * one under another, in the tree's order: each drawn by its own compare
 * view under a header with its controls. Documents only B has get a header
 * and a line saying so.
 */
function Review(props: FolderPanelProps & {comparing: Comparing}) {
	const ours = useMembers(() => props.host, () => ({overlay: props.comparing.a, at: props.comparing.aAt}))
	const theirs = useMembers(() => props.host, () => ({overlay: props.comparing.b, at: props.comparing.bAt}))
	const toRead = createMemo(
		() => {
			const a = ours()
			const b = theirs()
			return a && b ? foldersToRead(props.url, a, b) : {ours: [], theirs: []}
		},
		undefined,
		{equals: (x, y) => sameList(x.ours, y.ours) && sameList(x.theirs, y.theirs)}
	)
	const ourLinks = useFolderLinks(url => props.repo.find(url), () => toRead().ours)
	// B's folders, where the overlay provider says B's version of each is.
	const findTheirs = async (url: AutomergeUrl) => {
		const answer = await request<{url: AutomergeUrl; cloneUrl?: AutomergeUrl}>(props.host, {
			type: "repo:handle-descriptor",
			url,
			overlay: props.comparing.b,
			at: props.comparing.bAt,
		} as Selector)
		const base = (props.repo as Repo & {baseRepo?: Repo}).baseRepo ?? props.repo
		return base.find(answer.cloneUrl ?? answer.url)
	}
	const theirLinks = useFolderLinks(findTheirs, () => toRead().theirs)

	const sections = createMemo(() => {
		const a = ours()
		const b = theirs()
		if (!a || !b) return undefined
		const linksOf = (links: Map<string, Link[]>) => (url: AutomergeUrl) => links.get(documentOf(url))
		return review(props.url, a, b, linksOf(ourLinks()), linksOf(theirLinks()))
	})
	// By document, so a section stays put while its document changes.
	const ids = createMemo(() => (sections() ?? []).map(section => documentOf(section.url)), [], {
		equals: sameList,
	})
	const byId = createMemo(() => new Map((sections() ?? []).map(section => [documentOf(section.url), section])))

	// Each document both versions can show has a panel's compare state of
	// its own, starting with what's unchanged folded away.
	const states = new Map<string, PanelState>()
	const stateOf = (id: string) => {
		let state = states.get(id)
		if (!state) {
			state = createPanelState()
			state.setCollapsed(true)
			states.set(id, state)
		}
		return state
	}
	createEffect(() => {
		const shown = ids().filter(id => byId().get(id)?.side !== "theirs")
		for (const id of [...states.keys()]) if (!shown.includes(id)) states.delete(id)
		props.setSections(shown.map(stateOf))
	})
	onCleanup(() => props.setSections([]))

	// Where a document is in the project, from this folder down.
	const locationOf = (section: Section) =>
		formatLocationUrl({
			projectId: props.route.location.projectId,
			segments: [
				...props.route.resolved.trail.map(step => step.segment),
				...section.steps.map(step => step.segment),
			],
		}) as AutomergeUrl

	const [scroller, setScroller] = createSignal<HTMLElement>()
	return (
		<div ref={setScroller} class="projects__review">
			<Show when={sections()}>
				<Show
					when={ids().length > 0}
					fallback={<p class="projects__empty">Nothing beneath this folder differs.</p>}>
					<For each={ids()}>
						{id => (
							<Show when={byId().get(id)}>
								{section => (
									<ReviewSection
										section={section()}
										state={section().side === "theirs" ? undefined : stateOf(id)}
										modes={props.modes}
										comparing={props.comparing}
										versions={props.versions}
										root={scroller()}
										open={
											section().side === "theirs"
												? undefined
												: () => props.openTab(locationOf(section()))
										}
									/>
								)}
							</Show>
						)}
					</For>
				</Show>
			</Show>
		</div>
	)
}

/**
 * One document under review: a header with the arrow that folds it away,
 * its name, its folder when that's below the one reviewed, and its compare
 * controls; under it, the document compared, drawn once it's near the view.
 */
function ReviewSection(props: {
	section: Section
	/** its compare state; none for a document only B has */
	state: PanelState | undefined
	modes: PanelModes
	comparing: Comparing
	versions: Versions | undefined
	/** what it scrolls in */
	root: HTMLElement | undefined
	/** opens it in a tab of its own */
	open?(): void
}) {
	const [folded, setFolded] = createSignal(false)
	const [near, setNear] = createSignal(false)
	const [tool, setTool] = createSignal<string>()
	const name = () => props.section.steps.at(-1)?.name || "Untitled"
	const folder = () => {
		const above = props.section.steps.slice(0, -1).map(step => step.name)
		return above.length ? `${above.join("/")}/` : ""
	}
	const watch = (element: HTMLElement) => {
		const observer = new IntersectionObserver(
			seen => {
				if (!seen.some(each => each.isIntersecting)) return
				setNear(true)
				observer.disconnect()
			},
			{root: props.root, rootMargin: NEAR}
		)
		observer.observe(element)
		onCleanup(() => observer.disconnect())
	}
	return (
		<section class="projects__review-section" aria-label={name()}>
			<header class="projects__review-header">
				<button
					type="button"
					class="projects__review-fold"
					aria-expanded={!folded()}
					title={folded() ? "Show" : "Fold away"}
					onClick={() => setFolded(yn => !yn)}>
					<ChevronIcon open={!folded()} />
				</button>
				<span class="projects__review-name">{name()}</span>
				<Show when={folder()}>
					<span class="projects__review-folder">{folder()}</span>
				</Show>
				<div class="projects__review-actions">
					<Show when={props.state}>
						{state => (
							<PanelCompareControls
								panel={state()}
								modes={props.modes}
								comparing={true}
								versions={props.versions}
							/>
						)}
					</Show>
					<Show when={props.open}>
						{open => (
							<button
								type="button"
								class="projects__compare-picker"
								title="Open in a tab"
								aria-label="Open in a tab"
								onClick={() => open()()}>
								<OpenIcon />
							</button>
						)}
					</Show>
				</div>
			</header>
			<Show when={!folded()}>
				<Show
					when={props.state}
					fallback={<p class="projects__review-missing">Only in {props.comparing.names.b}</p>}>
					{state => (
						<div ref={watch} class="projects__review-body" style={{height: SECTION_HEIGHT}}>
							<Show when={near()}>
								<Compared
									url={props.section.url}
									toolId={undefined}
									tool={tool}
									setTool={setTool}
									compare={props.modes.compareOf(state())}
								/>
							</Show>
						</div>
					)}
				</Show>
			</Show>
		</section>
	)
}

/**
 * Each of `urls`' folder entries, by document, kept current as they change,
 * found with `find`.
 */
function useFolderLinks(
	find: (url: AutomergeUrl) => Promise<DocHandle<unknown>>,
	urls: Accessor<AutomergeUrl[]>
): Accessor<Map<string, Link[]>> {
	const [links, setLinks] = createSignal(new Map<string, Link[]>())
	createEffect(() => {
		const wanted = urls()
		const ids = new Set(wanted.map(documentOf))
		// What's read already stays until it's read again.
		const byFolder = new Map([...untrack(links)].filter(([id]) => ids.has(id)))
		const stops: (() => void)[] = []
		let live = true
		for (const url of wanted) {
			find(url).then(
				handle => {
					if (!live) return
					const update = () => {
						byFolder.set(documentOf(url), folderLinks(handle.doc()))
						setLinks(new Map(byFolder))
					}
					update()
					handle.on("change", update)
					stops.push(() => handle.off("change", update))
				},
				error => console.warn(`projects: couldn't read the folder ${url}`, error)
			)
		}
		onCleanup(() => {
			live = false
			for (const stop of stops) stop()
		})
	})
	return links
}

function sameList<T>(a: readonly T[], b: readonly T[]) {
	return a.length === b.length && a.every((each, i) => each === b[i])
}

// lucide `chevron-right`, turned down while open
function ChevronIcon(props: {open: boolean}) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			style={{rotate: props.open ? "90deg" : "0deg"}}
			aria-hidden="true">
			<path d="m9 18 6-6-6-6" />
		</svg>
	)
}

// lucide `arrow-up-right`
function OpenIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M7 7h10v10" />
			<path d="M7 17 17 7" />
		</svg>
	)
}
