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
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
	type Accessor,
	type Setter,
} from "solid-js"
import {render} from "solid-js/web"
import {useCompareModes, type WorkspaceCompare} from "./compare.ts"
import {useDocTitle} from "./hooks.ts"
import type {Placement, ProjectRoute, Side} from "./navigation.ts"
import {OpenWith} from "./open-with.tsx"
import {
	Compared,
	PanelCompareControls,
	createPanelModes,
	createPanelState,
	type Comparing,
	type PanelCompare,
	type PanelState,
} from "./panel.tsx"
import {projectRoot, relocate, type FindDoc} from "./resolve.ts"

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
}

/**
 * The project's documents, tiled. Each panel shows a place in the project;
 * an open goes where its route's placement says, or into the focused panel.
 * The focused panel is the route: focusing another one, or closing the last,
 * is reported back through `focus`. Nothing about the layout is kept.
 */
export function Dock(props: {
	route: ProjectRoute
	repo: Repo
	overlayKey: string
	comparing: Comparing | undefined
	focus(panel: ProjectRoute | undefined): void
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
		panels: panelList,
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
			if (route.resolved.docUrl) add(route)
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
		panels.set(id, {
			...createPanelState(),
			route: shown,
			setRoute: setShown,
			tool,
			setTool,
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
			if (id === focused || !route.resolved.docUrl) continue
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
						/>
					),
					element
				)
			},
			dispose: () => dispose?.(),
		}
	}

	// The compare and open-with menus in each group's tab bar, for the tab
	// it's showing.
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
						<Show when={panel()}>
							{panel => (
								<>
									<PanelCompareControls
										panel={panel()}
										modes={modes}
										comparing={!!props.comparing}
										versions={props.workspace.versions()}
									/>
									<Show when={panel().route().resolved.docUrl}>
										{url => (
											<OpenWith
												docUrl={url()}
												repo={props.repo}
												toolId={panel().tool()}
												pick={toolId => openWith(active(), url(), toolId)}
											/>
										)}
									</Show>
								</>
							)}
						</Show>
					)
				}, element)
			},
			dispose: () => dispose?.(),
		}
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

function DockPanel(props: {
	route: Accessor<ProjectRoute>
	repo: Repo
	overlayKey: Accessor<string>
	setTitle(title: string): void
	setTool(toolId: string | undefined): void
	tool: Accessor<string | undefined>
	compare: PanelCompare
}) {
	const docUrl = () => props.route().resolved.docUrl
	const title = useDocTitle(props.repo, docUrl)
	createEffect(() => props.setTitle(docUrl() ? (title() ?? "") : "Nothing open"))
	return (
		<Show when={docUrl()} fallback={<p class="projects__empty">{EMPTY}</p>}>
			{url => (
				// Most tools keep showing what they first read when their handle
				// moves onto another overlay's copy, so each overlay gets views of
				// its own.
				<Show when={props.overlayKey()} keyed>
					{_overlay => (
						<Compared
							url={url()}
							toolId={props.route().location.toolId}
							tool={props.tool}
							setTool={props.setTool}
							compare={props.compare}
						/>
					)}
				</Show>
			)}
		</Show>
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
