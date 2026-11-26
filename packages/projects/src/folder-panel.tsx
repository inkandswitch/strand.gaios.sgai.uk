import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {subscribe, type Selector} from "@inkandswitch/patchwork-providers"
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
import {folderLinks, segmentFor, type Link} from "./folders.ts"
import {useDoc, useHandle} from "./hooks.ts"
import {short, useHistory, useNow} from "./history.tsx"
import {formatLocationUrl} from "./location.ts"
import {documentOf, lastEdited} from "./members.ts"
import type {ProjectRoute} from "./navigation.ts"
import type {Member, OverlaysState} from "./types.ts"

/**
 * A folder open in a panel: its own entries, folders first, each with when
 * it was last edited, read through the panel's repo, so it follows the
 * checked-out overlay and the point in its history. A row opens its entry.
 */
export function FolderPanel(props: {
	url: AutomergeUrl
	route: ProjectRoute
	repo: Repo
	/** inside the overlay provider, where subscriptions go from */
	host: HTMLElement
	overlays: OverlaysState
	/** opens a location in the project, from this panel */
	open(url: AutomergeUrl): void
}) {
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

/** An overlay's members at a point, while it's asked for. */
export function useMembers(
	host: Accessor<HTMLElement | undefined>,
	version: Accessor<{overlay: AutomergeUrl | null; at: string | null} | undefined>
): Accessor<Member[] | undefined> {
	const [members, setMembers] = createSignal<Member[]>()
	const key = createMemo(() => {
		const current = version()
		return current && `${current.overlay ?? "main"}@${current.at ?? ""}`
	})
	createEffect(() => {
		const at = host()
		const which = key() && untrack(version)
		setMembers(undefined)
		if (!at || !which) return
		const selector = {type: "overlay:members", overlay: which.overlay, at: which.at} as Selector
		onCleanup(subscribe<Member[]>(at, selector, value => setMembers(value)))
	})
	return members
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
