import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {request} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, on, Show, untrack} from "solid-js"
import {Portal} from "solid-js/web"
import {CommentsScope} from "./comments.tsx"
import {createWorkspaceCompare, useCompareModes, type Mode, type WorkspaceCompare} from "./compare.ts"
import {WorkspaceHeader} from "./header.tsx"
import {useDocTitle, useMembers, useMounted} from "./hooks.ts"
import type {ProjectRoute} from "./navigation.ts"
import {OpenWith} from "./open-with.tsx"
import {
	Compared,
	PanelCompareControls,
	createPanelModes,
	createPanelState,
	type Comparing,
} from "./panel.tsx"
import {Provider} from "./provider.tsx"
import {FOLDER_TOOL} from "./tool-ids.ts"
import {provideWorkspace} from "./workspace.ts"
import type {SidebarToggle} from "./workspaces.tsx"
import {useOverlayState} from "./overlay-state.ts"
import {HistoryPanel, useMemberNames} from "./history.tsx"
import {covered} from "./members.ts"
import {createSidePanels} from "./side-panels.ts"
import {overlayName, versionKey, type At, type Overlay} from "./types.ts"

const COMPARE_PROVIDER = "patchwork-compare-provider"

/**
 * A root on a card, under a bar flat on the page with what's checked out,
 * and beside the card a column, also flat, with the history and the
 * comments. All of it seen through the overlay the provider around it has
 * checked out (`repo` is that provider's), and compared with another
 * version when one's picked. A folder
 * lays out what's open in it with its own tool, its tree beside its
 * documents; any other document is shown on its own.
 */
export function ProjectView(props: {
	route: ProjectRoute
	repo: Repo
	siteTitle: string
	focus(panel: ProjectRoute | undefined): void
	compare(overlay: Overlay | undefined, at?: At): void
	/** the sidebar, shown or hidden from the card header */
	sidebar: SidebarToggle
}) {
	const docUrl = () => props.route.resolved.docUrl
	const folder = () => props.route.resolved.root === "folder"
	const title = useDocTitle(props.repo, docUrl)
	// A folder's name is its title; another document's is whatever its view
	// calls it.
	const name = () => (folder() ? props.route.resolved.projectName : title()) ?? props.route.resolved.projectName
	const [provider, setProvider] = createSignal<HTMLElement>()
	const [desk, setDesk] = createSignal<HTMLElement>()
	const [actions, setActions] = createSignal<HTMLElement>()
	const [compareControls, setCompareControls] = createSignal<HTMLElement>()
	const mounted = useMounted(COMPARE_PROVIDER, provider)
	const state = useOverlayState(desk, mounted, () => props.route.resolved.projectUrl)
	const workspaceCompare = createWorkspaceCompare()
	const panels = createSidePanels()
	const names = useMemberNames(
		() => (mounted() ? desk() : undefined),
		props.repo,
		() => state.overlays()?.checkedOut
	)
	const modes = useCompareModes()
	// What's showing: what's in front in each of a folder's groups, or a
	// document on its own. The history and the comments cover it, a folder
	// as everything beneath it.
	const [showing, setShowing] = createSignal<AutomergeUrl[]>([])
	const shown = () => (folder() ? showing() : [props.route.resolved.projectUrl])
	const members = useMembers(
		() => (mounted() ? desk() : undefined),
		() => {
			const current = state.overlays()
			return current && {overlay: current.checkedOut, at: current.at}
		}
	)
	const visible = createMemo(() => covered(shown(), members() ?? [], props.route.resolved.projectUrl))
	// Named only when it's less than the whole project.
	const covering = () =>
		visible().whole
			? undefined
			: shown()
					.map(url => names().get(url)?.replace(/\/$/, ""))
					.filter(Boolean)
					.join(", ")
	// What it's compared with: an overlay, main (null), or nothing, and the
	// point in its history.
	const compared = () => {
		const current = state.comparison()
		return current ? current.b : undefined
	}
	const comparedAt = (): At => {
		const current = state.comparison()
		return current?.kind === "compare" ? current.bAt : null
	}

	createEffect(() => workspaceCompare.setVersions(state.versions()))

	createEffect(() => {
		// the project itself open is named once
		const inside = folder() && docUrl() !== props.route.resolved.projectUrl
		const shown = inside ? [title(), name()] : [name()]
		document.title = [...shown, props.siteTitle].filter(Boolean).join(" | ")
	})

	// The hash and the provider follow each other, once the provider has
	// started from the hash's.
	createEffect(() => {
		if (state.heard()) props.compare(compared(), comparedAt())
	})
	createEffect(
		on(
			() => [props.route.location.compare, props.route.location.compareAt ?? null] as const,
			([wanted, wantedAt]) => {
				const at = desk()
				if (!untrack(state.heard) || !at) return
				if (wanted === untrack(compared) && wantedAt === untrack(comparedAt)) return
				void request(
					at,
					wanted === undefined
						? {type: "compare:clear"}
						: {type: "compare:set", overlay: wanted, at: wantedAt}
				)
			},
			{defer: true}
		)
	)
	const against = () => {
		const wanted = props.route.location.compare
		return wanted === undefined ? undefined : (wanted ?? "main")
	}
	const againstAt = () =>
		props.route.location.compare === undefined ? undefined : props.route.location.compareAt

	return (
		<div class="projects__project">
			<patchwork-view
				ref={setProvider}
				component={COMPARE_PROVIDER}
				attr:against={against()}
				attr:against-at={againstAt()}
				class="projects__compare-scope">
				<div ref={setDesk} class="projects__desk">
					<Show when={mounted() && state.overlays() && desk()}>
						{at => (
							<>
								<WorkspaceHeader
									name={name()}
									overlays={state.overlays()!}
									comparison={state.comparison()}
									element={at()}
									sidebar={props.sidebar}
									panels={panels}
									names={names}
									compare={workspaceCompare}
									actions={setActions}
									compareControls={setCompareControls}
								/>
								<CommentsScope
									route={props.route}
									repo={props.repo}
									ours={overlayName(state.overlays(), state.overlays()!.checkedOut)}
									theirs={state.comparing()?.names.b}
									panels={panels}
									visible={visible()}
									covering={covering()}
									history={
										<Show when={state.overlays()?.status === "ready"}>
											<HistoryPanel
												element={at()}
												overlays={state.overlays()!}
												comparison={state.comparison()}
												names={names()}
												covers={visible().whole ? undefined : visible().docs}
											/>
										</Show>
									}>
									<Show
										when={folder()}
										fallback={
											<Show when={docUrl()}>
												{url => (
													<DocumentRoot
														url={url()}
														toolId={props.route.location.toolId}
														repo={props.repo}
														overlayKey={versionKey(state.overlays()!)}
														comparing={state.comparing()}
														workspace={workspaceCompare}
														modes={modes}
														actions={actions()}
														compareControls={compareControls()}
														element={at()}
													/>
												)}
											</Show>
										}>
										<FolderRoot
											url={props.route.resolved.projectUrl}
											route={props.route}
											focus={props.focus}
											showing={setShowing}
											workspace={workspaceCompare}
											modes={modes}
											element={at()}
										/>
									</Show>
								</CommentsScope>
							</>
						)}
					</Show>
				</div>
			</patchwork-view>
		</div>
	)
}

/**
 * A folder as the root, laid out by its own tool, which is told what's open
 * and reports back what it does with it (see `workspace.ts`).
 */
function FolderRoot(props: {
	url: AutomergeUrl
	route: ProjectRoute
	focus(panel: ProjectRoute | undefined): void
	showing(urls: AutomergeUrl[]): void
	workspace: WorkspaceCompare
	modes: () => Mode[]
	element: HTMLElement
}) {
	provideWorkspace(props.element, {
		route: () => props.route,
		focus: route => props.focus(route),
		showing: urls => props.showing(urls),
		compare: props.workspace,
		modes: props.modes,
	})
	return (
		<patchwork-view class="projects__root-tool" tool-id={FOLDER_TOOL} doc-url={props.url} />
	)
}

/**
 * A document as the root, shown on its own: compared like a panel of a
 * folder's dock, with its controls, and "Open with", in the header.
 */
function DocumentRoot(props: {
	url: AutomergeUrl
	toolId: string | undefined
	repo: Repo
	overlayKey: string
	comparing: Comparing | undefined
	workspace: WorkspaceCompare
	modes: () => Mode[]
	/** where in the header its controls go */
	actions: HTMLElement | undefined
	/** where in the header its compare controls go, beside the drafts */
	compareControls: HTMLElement | undefined
	element: HTMLElement
}) {
	const panel = createPanelState()
	const [tool, setTool] = createSignal<string>()
	const panelModes = createPanelModes({
		modes: props.modes,
		workspace: props.workspace,
		comparing: () => props.comparing,
		panels: () => [panel],
	})
	const openWith = (toolId: string) =>
		props.element.dispatchEvent(
			new CustomEvent("patchwork:open-document", {
				detail: {url: props.url, toolId},
				bubbles: true,
				composed: true,
			})
		)

	return (
		<>
			<Show when={props.compareControls}>
				{at => (
					<Portal mount={at()}>
						<PanelCompareControls
							panel={panel}
							modes={panelModes}
							comparing={!!props.comparing}
							versions={props.workspace.versions()}
							picker={false}
						/>
					</Portal>
				)}
			</Show>
			<Show when={props.actions}>
				{at => (
					<Portal mount={at()}>
						<OpenWith docUrl={props.url} repo={props.repo} toolId={tool()} pick={openWith} />
					</Portal>
				)}
			</Show>
			<div class="projects__body projects__body--document">
				<main class="projects__main">
							{/* Most tools keep showing what they first read when their
							    handle moves onto another overlay's copy, so each overlay
							    gets a view of its own. */}
							<Show when={props.overlayKey} keyed>
								{_overlay => (
									<Compared
										url={props.url}
										toolId={props.toolId}
										tool={tool}
										setTool={setTool}
										compare={panelModes.compareOf(panel)}
									/>
								)}
							</Show>
				</main>
			</div>
		</>
	)
}
