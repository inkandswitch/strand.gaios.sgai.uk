import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {accept, subscribe, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
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
	type JSX,
	type Setter,
} from "solid-js"
import {render} from "solid-js/web"
import {
	drawnByView,
	offered,
	optionsIn,
	useCompareModes,
	type CompareSelector,
	type CompareView,
	type ComparedVersion,
	type Mode,
	type Options,
} from "./compare.ts"
import {ComparePicker} from "./compare-ui.tsx"
import {useDocTitle, useMounted} from "./hooks.ts"
import type {Placement, ProjectRoute, Side} from "./navigation.ts"
import {OpenWith} from "./open-with.tsx"
import {projectRoot, relocate, type FindDoc} from "./resolve.ts"

const EMPTY = "Open something from the project, or make something new."

/** what a sidebar row's drag carries its location as (sideboard's `LOCATION_TYPE`) */
const LOCATION_TYPE = "text/x-patchwork-location"

const THEME: DockviewTheme = {
	...themeLight,
	name: "gaios",
	className: `${themeLight.className} projects__dock-theme`,
	gap: 8,
}

/** One of the dock's groups of tabs, named after what it shows. */
export type DockGroup = {id: string; title: string}

/**
 * The draft the checked-out one is compared with: views of it are checked
 * out of the workspace by a draft provider of their own. `draft` is unset
 * for main. `merging` while the checked-out draft's merge into it is looked
 * over: then the document shows as `after`, the hidden draft the merge's
 * preview is on, once it's made, read-only, beside the draft as it is.
 */
export type Comparing = {
	workspace: AutomergeUrl
	draft: AutomergeUrl | undefined
	name: string
	merging: boolean
	after: AutomergeUrl | undefined
}

type Panel = {
	route: Accessor<ProjectRoute>
	setRoute: Setter<ProjectRoute>
	/** the tool its document's view mounted, the route's or the fallback */
	tool: Accessor<string | undefined>
	setTool: Setter<string | undefined>
	/** what its document's view asked of the compare modes */
	asked: Accessor<CompareSelector | undefined>
	setAsked: Setter<CompareSelector | undefined>
	/** a compare mode picked for it alone, with options of its own */
	override: Accessor<string | undefined>
	setOverride: Setter<string | undefined>
	options: Map<string, Options<unknown>>
}

/** Its compare mode, worked out for a panel's view. */
type PanelCompare = Pick<Panel, "asked" | "setAsked"> & {
	comparing(): Comparing | undefined
	mode(): Mode | undefined
	options(mode: Mode): Options<unknown>
}

/** What a panel shows when its view prefers no mode it takes. */
const FALLBACK_MODE = "side-by-side"

/**
 * The project's documents, tiled. Each panel shows a place in the project;
 * an open goes where its route's placement says, or into the focused panel.
 * The focused panel is the route: focusing another one, or closing the last,
 * is reported back through `focus`. Nothing about the layout is kept.
 */
export function Dock(props: {
	route: ProjectRoute
	repo: Repo
	draftKey: string
	comparing: Comparing | undefined
	focus(panel: ProjectRoute | undefined): void
	/** where the dock's groups are offered, for opening into one */
	host: HTMLElement | undefined
}) {
	const panels = new Map<string, Panel>()
	const [groups, setGroups] = createSignal<DockGroup[]>([])
	const modes = useCompareModes()
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

	createEffect(on(() => props.draftKey, relocateOthers, {defer: true}))

	createEffect(() => {
		const host = props.host
		if (host) offerGroups(host, groups)
	})

	return (
		<div class="projects__dock-area">
			<div ref={element} class="projects__dock" />
		</div>
	)

	function offeredTo(panel: Panel) {
		return modes().filter(mode => offered(mode, panel.asked()))
	}

	// The one picked for it, else the one its view prefers.
	function modeOf(panel: Panel) {
		const list = offeredTo(panel)
		const wanted = panel.override() ?? panel.asked()?.prefers
		return (
			list.find(mode => mode.id === wanted) ??
			list.find(mode => mode.id === FALLBACK_MODE) ??
			list[0]
		)
	}

	function optionsOf(panel: Panel, mode: Mode) {
		return optionsIn(panel.options, mode)
	}

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
		const [asked, setAsked] = createSignal<CompareSelector>()
		const [override, setOverride] = createSignal<string>()
		panels.set(id, {
			route: shown,
			setRoute: setShown,
			tool,
			setTool,
			asked,
			setAsked,
			override,
			setOverride,
			options: new Map(),
		})
		api?.addPanel({id, component: "document", title: "", position})
	}

	// On another draft, what the other panels show may have moved, or not be
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
							draftKey={() => props.draftKey}
							setTitle={title => {
								panelApi.setTitle(title)
								if (api) setGroups(groupsOf(api))
							}}
							setTool={panel.setTool}
							tool={panel.tool}
							compare={{
								comparing: () => props.comparing,
								asked: panel.asked,
								setAsked: panel.setAsked,
								mode: () => modeOf(panel),
								options: mode => optionsOf(panel, mode),
							}}
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
									<Show when={props.comparing && modeOf(panel())}>
										{mode => (
											<ComparePicker
												modes={offeredTo(panel())}
												current={mode()}
												overridden={panel().override() !== undefined}
												pick={panel().setOverride}
												options={mode => optionsOf(panel(), mode)}
											/>
										)}
									</Show>
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
	draftKey: Accessor<string>
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
				// moves onto another draft's copy, so each draft gets views of its
				// own.
				<Show when={props.draftKey()} keyed>
					{_draft => (
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
 * A document, and while the checked-out draft is compared with another, that
 * draft's version beside it, laid out by the compare mode, unless the
 * document's view draws the mode itself. The view showing the document stays
 * put as the mode changes, and is told the mode and the other version.
 */
function Compared(props: {
	url: AutomergeUrl
	toolId: string | undefined
	tool: Accessor<string | undefined>
	setTool(toolId: string | undefined): void
	compare: PanelCompare
}) {
	const [slotB, setSlotB] = createSignal<HTMLDivElement>()
	const [version, setVersion] = createSignal<ComparedVersion>(null)
	let host!: HTMLDivElement
	let slotA!: HTMLDivElement
	let view!: HTMLElement
	const comparing = () => props.compare.comparing()
	const mode = () => (comparing() ? props.compare.mode() : undefined)
	const laidOut = () => {
		const current = mode()
		if (!current?.module.compose || drawnByView(current, props.compare.asked())) return
		return current
	}
	const missing = () => version()?.doc === null
	const merging = () => !!comparing()?.merging

	onMount(() => {
		createEffect(() => {
			if (!comparing()) return setVersion(null)
			onCleanup(
				subscribe(host, {type: "compare:version", url: props.url}, next =>
					setVersion(() => next as unknown as ComparedVersion)
				)
			)
		})
	})

	createEffect(() => {
		const current = laidOut()
		const b = slotB()
		if (!current || !b) return
		onCleanup(current.module.compose!({a: slotA, b}, props.compare.options(current)))
	})

	const told = new Set<(view: CompareView) => void>()
	let latest: () => CompareView = () => NOT_COMPARED
	createEffect(() => {
		const current = mode()
		const other = version()
		const options = current && props.compare.options(current)
		latest = () => ({
			mode: current?.id ?? null,
			options: options ? options.current() : null,
			other: current ? (other?.doc ?? null) : null,
			missing: !!current && other?.doc === null,
		})
		const tell = () => {
			for (const respond of told) respond(latest())
		}
		tell()
		if (options) onCleanup(options.subscribe(tell))
	})

	// Only the document's own view is told: views inside it aren't comparing
	// anything, and nor are the other draft's.
	const onSubscribe = (event: SubscribeEvent) => {
		const selector = event.detail.selector as CompareSelector
		if (selector.type !== "compare:view") return
		const target = event.target as HTMLElement
		if (target === view) {
			accept<CompareView>(event, respond => {
				props.compare.setAsked(selector)
				told.add(respond)
				respond(latest())
				return () => {
					told.delete(respond)
					if (props.compare.asked() === selector) props.compare.setAsked(undefined)
				}
			})
		} else if (slotB()?.contains(target)) {
			accept<CompareView>(event, respond => respond(NOT_COMPARED))
		}
	}
	onMount(() => host.addEventListener("patchwork:subscribe", onSubscribe as EventListener))
	onCleanup(() => host.removeEventListener("patchwork:subscribe", onSubscribe as EventListener))

	// Only the document's own view: views inside the document mount too.
	const reportTool = (element: HTMLElement) => {
		view = element
		element.addEventListener("patchwork:mounted", event => {
			if (event.target !== element) return
			const detail = (event as CustomEvent<{toolId?: string}>).detail
			props.setTool(detail?.toolId)
		})
	}

	return (
		<div ref={host} class="projects__compare" classList={{"projects__compare--merge": merging()}}>
			<div ref={slotA} class="projects__compare-slot" data-version="a">
				<Show
					when={merging() && comparing()}
					fallback={
						<patchwork-view
							ref={reportTool}
							class="projects__document"
							doc-url={props.url}
							tool-id={props.toolId}
						/>
					}>
					{merge => (
						<Show
							when={merge().after}
							keyed
							fallback={<p class="projects__empty">Working out the merge…</p>}>
							{after => (
								<Show
									when={!version()?.removed}
									fallback={<p class="projects__empty">Removed by the merge</p>}>
									<ReadOnly>
										<OtherDraft workspace={merge().workspace} draft={after}>
											<patchwork-view
												ref={reportTool}
												class="projects__document"
												doc-url={props.url}
												tool-id={props.tool() ?? props.toolId}
											/>
										</OtherDraft>
									</ReadOnly>
								</Show>
							)}
						</Show>
					)}
				</Show>
			</div>
			<Show when={laidOut() && comparing()}>
				{other => (
					<div ref={setSlotB} class="projects__compare-slot" data-version="b">
						<Show
							when={!missing()}
							fallback={<p class="projects__empty">Not in {other().name}</p>}>
							<Show when={other().draft ?? "main"} keyed>
								{_draft => (
									<OtherDraft workspace={other().workspace} draft={other().draft}>
										<patchwork-view
											class="projects__document"
											doc-url={props.url}
											tool-id={props.tool() ?? props.toolId}
										/>
									</OtherDraft>
								)}
							</Show>
						</Show>
					</div>
				)}
			</Show>
		</div>
	)
}

/** The workspace with `draft` checked out (main when unset), for the views inside. */
function OtherDraft(props: {
	workspace: AutomergeUrl
	draft: AutomergeUrl | undefined
	children: JSX.Element
}) {
	const [element, setElement] = createSignal<HTMLElement>()
	const mounted = useMounted("patchwork-draft-provider", element)
	return (
		<patchwork-view
			ref={setElement}
			class="projects__other-draft"
			component="patchwork-draft-provider"
			doc-url={props.workspace}
			attr:draft={props.draft}>
			<Show when={mounted()}>{props.children}</Show>
		</patchwork-view>
	)
}

/**
 * Views inside can be read, scrolled, searched and copied from, but nothing
 * typed, pasted or dropped reaches them.
 */
function ReadOnly(props: {children: JSX.Element}) {
	let element!: HTMLDivElement
	onMount(() => {
		const block = (event: Event) => {
			event.preventDefault()
			event.stopPropagation()
		}
		const onKey = (event: KeyboardEvent) => {
			const reading =
				READING_KEYS.has(event.key) ||
				((event.metaKey || event.ctrlKey) && READING_SHORTCUTS.has(event.key.toLowerCase()))
			if (!reading) block(event)
		}
		const blocked = ["beforeinput", "paste", "cut", "drop"] as const
		for (const type of blocked) element.addEventListener(type, block, true)
		element.addEventListener("keydown", onKey, true)
		onCleanup(() => {
			for (const type of blocked) element.removeEventListener(type, block, true)
			element.removeEventListener("keydown", onKey, true)
		})
	})
	return (
		<div ref={element} class="projects__read-only">
			{props.children}
		</div>
	)
}

const READING_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	"Tab",
	"Escape",
	"Shift",
	"Meta",
	"Control",
	"Alt",
])

const READING_SHORTCUTS = new Set(["a", "c", "f", "g"])

const NOT_COMPARED: CompareView = {mode: null, options: null, other: null, missing: false}

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
