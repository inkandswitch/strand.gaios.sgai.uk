import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {accept, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
import type {
	AddPanelPositionOptions,
	DockviewApi,
	DockviewGroupPanel,
	DockviewTheme,
	IContentRenderer,
	IHeaderActionsRenderer,
	IWatermarkRenderer,
	Position,
} from "dockview-core"
import {createDockview, themeLight} from "dockview-core/dist/dockview-core.js"
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
	type Accessor,
	type Setter,
} from "solid-js"
import {render} from "solid-js/web"
import {useCompareModes, type Versions, type WorkspaceCompare} from "./compare.ts"
import {FolderPanel} from "./folder-panel.tsx"
import {useDocTitle} from "./hooks.ts"
import {nothingOpen, type Placement, type ProjectRoute, type Side} from "./navigation.ts"
import {OpenWith} from "./open-with.tsx"
import {
	Compared,
	PanelCompareControls,
	createPanelModes,
	createPanelState,
	type Comparing,
	type PanelCompare,
	type PanelModes,
	type PanelState,
} from "./panel.tsx"
import {projectRoot, relocate, showsFolder, type FindDoc} from "./resolve.ts"
import type {OverlaysState} from "./types.ts"

const EMPTY = "Open something from the project, or make something new."

/** what a sidebar row's drag carries its location as (sideboard's `LOCATION_TYPE`) */
const LOCATION_TYPE = "text/x-patchwork-location"

const THEME: DockviewTheme = {
	...themeLight,
	name: "gaios",
	className: `${themeLight.className} projects__dock-theme`,
	// flat on the card, split by hairlines
	gap: 0,
}

/** One of the dock's groups of tabs, named after what it shows. */
export type DockGroup = {id: string; title: string}

type Panel = PanelState & {
	route: Accessor<ProjectRoute>
	setRoute: Setter<ProjectRoute>
	/** the tool its document's view mounted, the route's or the fallback */
	tool: Accessor<string | undefined>
	setTool: Setter<string | undefined>
	/** whether what it shows is a folder */
	folder: Accessor<boolean>
	/** a folder's documents under review, each compared like a panel */
	sections: Accessor<PanelState[]>
	setSections: Setter<PanelState[]>
}

/**
 * The project's documents and folders, tiled. Each panel shows a place in
 * the project; an open goes where its route's placement says, or into the
 * focused panel.
 * The focused panel is the route: focusing another one, or closing the last,
 * is reported back through `focus`. Nothing about the layout is kept.
 */
export function Dock(props: {
	route: ProjectRoute
	repo: Repo
	overlayKey: string
	overlays: OverlaysState
	comparing: Comparing | undefined
	focus(panel: ProjectRoute | undefined): void
	/** what's in front in each group, by its url */
	showing(urls: AutomergeUrl[]): void
	/** where the dock's groups are offered, for opening into one */
	host: HTMLElement | undefined
	/** the modes every panel shares */
	workspace: WorkspaceCompare
}) {
	const panels = new Map<string, Panel>()
	const [panelList, setPanelList] = createSignal<Panel[]>([])
	const [groups, setGroups] = createSignal<DockGroup[]>([])
	const modes = createPanelModes({
		modes: useCompareModes(),
		workspace: props.workspace,
		comparing: () => props.comparing,
		// a folder's panel has no mode of its own, but its documents under
		// review each have theirs
		panels: () =>
			panelList().flatMap(panel =>
				panel.folder() ? panel.sections() : [panel]
			),
	})
	let element!: HTMLDivElement
	let api: DockviewApi | undefined
	let count = 0

	onMount(() => {
		const dock = createDockview(element, {
			theme: THEME,
			disableFloatingGroups: true,
			createComponent: () => panelRenderer(),
			createRightHeaderActionComponent: () => groupActions(),
			createWatermarkComponent: () => watermark(),
		})
		api = dock
		const refresh = () => setGroups(groupsOf(dock))
		const subscriptions = [
			dock.onDidActivePanelChange(({panel}) => {
				const shown = panel && panels.get(panel.id)
				if (shown) props.focus(shown.route())
				refresh()
			}),
			dock.onDidRemovePanel(panel => {
				panels.delete(panel.id)
				setPanelList([...panels.values()])
				refresh()
				if (!dock.totalPanels) props.focus(undefined)
			}),
			dock.onDidLayoutChange(refresh),
			...takeDrops(dock),
		]
		onCleanup(() => {
			for (const subscription of subscriptions) subscription.dispose()
			dock.dispose()
			api = undefined
		})
	})

	createEffect(on(() => props.route, place))

	createEffect(on(() => props.overlayKey, relocateOthers, {defer: true}))

	createEffect(() => {
		const host = props.host
		if (host) offerGroups(host, groups)
	})

	// Only the tab in front in each group is showing; the ones behind it
	// aren't on screen.
	const showing = createMemo(
		() => {
			groups()
			panelList()
			const urls = (api?.groups ?? []).flatMap(group => {
				const panel = group.activePanel && panels.get(group.activePanel.id)
				return panel ? [withoutHeads(panel.route().resolved.docUrl)] : []
			})
			return [...new Set(urls)]
		},
		[],
		{equals: (a, b) => a.length === b.length && a.every((url, i) => url === b[i])}
	)
	createEffect(() => props.showing(showing()))

	return (
		<div class="projects__dock-area">
			<div ref={element} class="projects__dock" />
		</div>
	)

	function place(route: ProjectRoute) {
		if (!api) return
		const active = api.activePanel
		const placement = route.placement
		const target = groupTarget(api, placement)
		if (target) {
			panels.get(target.id)?.setRoute(route)
			target.api.setActive()
		} else if (!active) {
			// the project's own tab only when it's asked for
			if (!nothingOpen(route)) add(route)
		} else if (placement && "to" in placement) {
			add(route, positionFor(api, placement, active.group.id))
		} else {
			panels.get(active.id)?.setRoute(route)
		}
	}

	// A row dragged out of the sidebar opens where it's dropped: in the
	// middle of a group in place of what it shows, on its tab bar or just
	// under it as a new tab (a line shows between which tabs), at its edges
	// beside it. The dock's own edges only take a drop when it's empty: a
	// group's edges already split.
	function takeDrops(dock: DockviewApi) {
		const marker = insertionMarker()
		const onLeave = (event: DragEvent) => {
			if (!element.contains(event.relatedTarget as Node | null)) marker.clear()
		}
		element.addEventListener("dragleave", onLeave)
		document.addEventListener("dragend", marker.clear)
		return [
			dock.onUnhandledDragOver(event => {
				const native = event.nativeEvent
				if (!(native instanceof DragEvent) || !carriesLocation(native)) return
				if (event.target === "edge" && dock.totalPanels) return marker.clear()
				event.accept()
				if (intoTabs(event)) marker.show(event.group!, tabIndex(event.group!, native.clientX))
				else marker.clear()
			}),
			dock.onDidDrop(event => {
				marker.clear()
				if (event.getData() || !(event.nativeEvent instanceof DragEvent)) return
				const url = event.nativeEvent.dataTransfer?.getData(LOCATION_TYPE)
				if (url) open(url, dropPlacement(event))
			}),
			{
				dispose() {
					element.removeEventListener("dragleave", onLeave)
					document.removeEventListener("dragend", marker.clear)
					marker.clear()
				},
			},
		]

		function insertionMarker() {
			let shown: {group: string; index: number; line: HTMLElement} | undefined
			const clear = () => {
				delete element.dataset.drop
				shown?.line.remove()
				shown = undefined
			}
			const show = (group: DockviewGroupPanel, index: number) => {
				element.dataset.drop = "tab"
				if (shown?.group === group.id && shown.index === index) return
				const container = group.element.querySelector(".dv-tabs-container")
				if (!container) return clear()
				const line = shown?.line ?? document.createElement("div")
				line.className = "projects__tab-insertion"
				container.insertBefore(line, tabsOf(group)[index] ?? null)
				shown = {group: group.id, index, line}
			}
			return {show, clear}
		}
	}

	function open(url: string, placement: Placement | undefined) {
		element.dispatchEvent(
			new CustomEvent("patchwork:open-document", {
				detail: {url, placement},
				bubbles: true,
				composed: true,
			})
		)
	}

	function add(route: ProjectRoute, position?: AddPanelPositionOptions) {
		const id = `panel-${++count}`
		const [shown, setShown] = createSignal(route)
		const [tool, setTool] = createSignal<string>()
		const [sections, setSections] = createSignal<PanelState[]>([])
		panels.set(id, {
			...createPanelState(),
			route: shown,
			setRoute: setShown,
			tool,
			setTool,
			folder: () => showsFolder(shown().resolved),
			sections,
			setSections,
		})
		setPanelList([...panels.values()])
		api?.addPanel({id, component: "document", title: "", position})
	}

	// On another overlay, what the other panels show may have moved, or not be
	// there at all. The focused one goes with the route.
	function relocateOthers() {
		const find: FindDoc = async url => (await props.repo.find(url)).doc()
		const focused = api?.activePanel?.id
		for (const [id, panel] of panels) {
			const route = panel.route()
			if (id === focused) continue
			void relocate(route.resolved, find).then(next => {
				if (panels.get(id) !== panel || panel.route() !== route) return
				panel.setRoute(
					next
						? {...route, resolved: next}
						: {resolved: projectRoot(route.resolved), location: route.location}
				)
			})
		}
	}

	function panelRenderer(): IContentRenderer {
		const element = document.createElement("div")
		element.className = "projects__dock-panel"
		let dispose: (() => void) | undefined
		return {
			element,
			init({api: panelApi}) {
				const panel = panels.get(panelApi.id)
				if (!panel) return
				dispose = render(
					() => (
						<DockPanel
							route={panel.route}
							repo={props.repo}
							overlayKey={() => props.overlayKey}
							setTitle={title => {
								panelApi.setTitle(title)
								if (api) setGroups(groupsOf(api))
							}}
							setTool={panel.setTool}
							tool={panel.tool}
							compare={modes.compareOf(panel)}
							host={props.host}
							overlays={() => props.overlays}
							open={url => openFrom(panelApi.id, url)}
							openTab={url => openTab(panelApi.id, url)}
							modes={modes}
							versions={() => props.workspace.versions()}
							setSections={panel.setSections}
						/>
					),
					element
				)
			},
			dispose: () => dispose?.(),
		}
	}

	// The compare and open-with menus in each group's tab bar, for the tab
	// it's showing, if it's a document.
	function groupActions(): IHeaderActionsRenderer {
		const element = document.createElement("div")
		element.className = "projects__group-actions"
		let dispose: (() => void) | undefined
		return {
			element,
			init({api: groupApi, group}) {
				dispose = render(() => {
					const [active, setActive] = createSignal(group.activePanel?.id)
					const subscription = groupApi.onDidActivePanelChange(event =>
						setActive(event.panel?.id)
					)
					onCleanup(() => subscription.dispose())
					const panel = () => {
						const id = active()
						return id === undefined ? undefined : panels.get(id)
					}
					return (
						<Show when={!panel()?.folder() && panel()}>
							{panel => (
								<>
									<PanelCompareControls
										panel={panel()}
										modes={modes}
										comparing={!!props.comparing}
										versions={props.workspace.versions()}
									/>
									<OpenWith
										docUrl={panel().route().resolved.docUrl}
										repo={props.repo}
										toolId={panel().tool()}
										pick={toolId => openWith(active(), panel().route().resolved.docUrl, toolId)}
									/>
								</>
							)}
						</Show>
					)
				}, element)
			},
			dispose: () => dispose?.(),
		}
	}

	// A row of a folder panel opens in the pane beside it, so the folder
	// stays in view, or as a tab in its own group when it's alone.
	function openFrom(panelId: string, url: AutomergeUrl) {
		const panel = api?.getPanel(panelId)
		if (!api || !panel) return
		const own = panel.group
		const beside = nearest(own, api.groups.filter(group => group !== own))
		open(url, beside ? {group: beside.id} : {to: "tab", group: own.id})
	}

	// A document under review opens in a tab of its own, beside the folder's.
	function openTab(panelId: string, url: AutomergeUrl) {
		const group = api?.getPanel(panelId)?.group
		if (group) open(url, {to: "tab", group: group.id})
	}

	// "Open with" reopens the open document under another tool, and it's the
	// focused panel that's open: focus this one first.
	function openWith(panelId: string | undefined, url: AutomergeUrl, toolId: string) {
		const panel = panelId === undefined ? undefined : api?.getPanel(panelId)
		if (!panel) return
		panel.api.setActive()
		element.dispatchEvent(
			new CustomEvent("patchwork:open-document", {
				detail: {url, toolId},
				bubbles: true,
				composed: true,
			})
		)
	}
}

/**
 * What a panel shows: a folder's entries, or a document, compared while
 * two versions are.
 */
function DockPanel(props: {
	route: Accessor<ProjectRoute>
	repo: Repo
	overlayKey: Accessor<string>
	setTitle(title: string): void
	setTool(toolId: string | undefined): void
	tool: Accessor<string | undefined>
	compare: PanelCompare
	host: HTMLElement | undefined
	overlays: Accessor<OverlaysState>
	open(url: AutomergeUrl): void
	openTab(url: AutomergeUrl): void
	modes: PanelModes
	versions: Accessor<Versions | undefined>
	setSections(sections: PanelState[]): void
}) {
	const docUrl = () => props.route().resolved.docUrl
	const folder = () => showsFolder(props.route().resolved)
	const title = useDocTitle(props.repo, docUrl)
	// A folder is named as it's named in the project until its title loads.
	const named = () => props.route().resolved.trail.at(-1)?.segment ?? props.route().resolved.projectName
	createEffect(() => props.setTitle(title() ?? (folder() ? named() : "")))
	return (
		// Most tools keep showing what they first read when their handle moves
		// onto another overlay's copy, so each overlay gets views of its own.
		<Show when={props.overlayKey()} keyed>
			{_overlay => (
				<Show
					when={folder()}
					fallback={
						<Compared
							url={docUrl()}
							toolId={props.route().location.toolId}
							tool={props.tool}
							setTool={props.setTool}
							compare={props.compare}
						/>
					}>
					<Show when={props.host}>
						{host => (
							<FolderPanel
								url={withoutHeads(docUrl())}
								route={props.route()}
								repo={props.repo}
								host={host()}
								overlays={props.overlays()}
								open={props.open}
								openTab={props.openTab}
								comparing={props.compare.comparing()}
								modes={props.modes}
								versions={props.versions()}
								setSections={props.setSections}
							/>
						)}
					</Show>
				</Show>
			)}
		</Show>
	)
}

function withoutHeads(url: AutomergeUrl): AutomergeUrl {
	return url.split("#")[0] as AutomergeUrl
}

// The group whose middle is nearest `group`'s.
function nearest(group: DockviewGroupPanel, others: DockviewGroupPanel[]) {
	const middle = (each: DockviewGroupPanel) => {
		const box = each.element.getBoundingClientRect()
		return {x: box.left + box.width / 2, y: box.top + box.height / 2}
	}
	const from = middle(group)
	const distance = (each: DockviewGroupPanel) => {
		const to = middle(each)
		return Math.hypot(to.x - from.x, to.y - from.y)
	}
	return others.reduce<DockviewGroupPanel | undefined>(
		(best, each) => (!best || distance(each) < distance(best) ? each : best),
		undefined
	)
}


/**
 * Answer `dock:groups` for everything inside `element`: the dock's groups,
 * kept current, so a menu can offer to open something into one of them.
 */
function offerGroups(element: HTMLElement, groups: Accessor<DockGroup[]>) {
	const listeners = new Set<(groups: DockGroup[]) => void>()
	const onSubscribe = (event: SubscribeEvent) => {
		if (event.detail.selector.type !== "dock:groups") return
		accept<DockGroup[]>(event, respond => {
			respond(groups())
			listeners.add(respond)
			return () => {
				listeners.delete(respond)
			}
		})
	}
	element.addEventListener("patchwork:subscribe", onSubscribe as EventListener)
	createEffect(
		on(
			groups,
			current => {
				for (const respond of listeners) respond(current)
			},
			{defer: true}
		)
	)
	onCleanup(() => {
		element.removeEventListener(
			"patchwork:subscribe",
			onSubscribe as EventListener
		)
		listeners.clear()
	})
}

// Two groups showing the same thing are told apart by where they come.
function groupsOf(api: DockviewApi): DockGroup[] {
	const titles = api.groups.map(group => group.activePanel?.title || "Nothing open")
	return api.groups.map((group, index) => {
		const title = titles[index]
		const same = titles.filter(other => other === title).length
		const nth = titles.slice(0, index + 1).filter(other => other === title).length
		return {id: group.id, title: same > 1 ? `${title} (${nth})` : title}
	})
}

// Only a placement naming a group and nothing else replaces what it shows.
function groupTarget(api: DockviewApi, placement: Placement | undefined) {
	if (!placement || "to" in placement) return undefined
	return api.getGroup(placement.group)?.activePanel
}

function positionFor(
	api: DockviewApi,
	placement: Extract<Placement, {to: string}>,
	focusedGroup: string
): AddPanelPositionOptions {
	if ("edge" in placement) return {direction: placement.to}
	const named = placement.group
	const referenceGroup = named && api.getGroup(named) ? named : focusedGroup
	if (placement.to !== "tab") return {referenceGroup, direction: placement.to}
	const last = api.getGroup(referenceGroup)?.panels.length
	return {referenceGroup, index: "index" in placement ? placement.index : last}
}

function carriesLocation(event: DragEvent) {
	return !!event.dataTransfer?.types.includes(LOCATION_TYPE)
}

// Where across a group's tabs `x` falls: before the first tab whose middle
// it's left of, or after the last.
function tabIndex(group: DockviewGroupPanel, x: number) {
	const tabs = tabsOf(group)
	const before = tabs.findIndex(tab => {
		const box = tab.getBoundingClientRect()
		return x < box.left + box.width / 2
	})
	return before < 0 ? tabs.length : before
}

function tabsOf(group: DockviewGroupPanel) {
	return [...group.element.querySelectorAll<HTMLElement>(".dv-tabs-container > .dv-tab")]
}

type DropAt = {
	nativeEvent: DragEvent | PointerEvent
	position: Position
	group?: DockviewGroupPanel
}

function dropPlacement(drop: DropAt): Placement | undefined {
	const {position, group} = drop
	if (!group) return position === "center" ? undefined : {to: SIDE_OF[position], edge: true}
	if (intoTabs(drop))
		return {to: "tab", group: group.id, index: tabIndex(group, drop.nativeEvent.clientX)}
	return position === "center" ? {group: group.id} : {to: SIDE_OF[position], group: group.id}
}

// On a group's tab bar, or in a band just under it where a split above would
// otherwise start: that takes a new tab, and splitting above starts lower.
// Only the height counts: over a tab, dockview says left or right of it.
function intoTabs({nativeEvent, group}: DropAt) {
	if (!group) return false
	const tabs = group.element.querySelector(".dv-tabs-and-actions-container")
	const bottom = (tabs ?? group.element).getBoundingClientRect().bottom
	return nativeEvent.clientY < bottom + TAB_BAND
}

const TAB_BAND = 32

const SIDE_OF: Record<Exclude<Position, "center">, Side> = {
	top: "above",
	bottom: "below",
	left: "left",
	right: "right",
}

function watermark(): IWatermarkRenderer {
	const element = document.createElement("p")
	element.className = "projects__empty"
	element.textContent = EMPTY
	return {element, init() {}}
}
