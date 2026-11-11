import type {Repo} from "@automerge/automerge-repo/slim"
import {accept, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
import type {
	AddPanelPositionOptions,
	DockviewApi,
	DockviewTheme,
	IContentRenderer,
	IWatermarkRenderer,
} from "dockview-core"
import {createDockview, themeLight} from "dockview-core/dist/dockview-core.js"
import {
	createEffect,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	type Accessor,
	type Setter,
} from "solid-js"
import {render} from "solid-js/web"
import {useDocTitle} from "./hooks.ts"
import type {Placement, ProjectRoute} from "./navigation.ts"
import {projectRoot, relocate, type FindDoc} from "./resolve.ts"

/** Each has to be installed: a tool `<patchwork-view>` can't find shows an error. */
const TITLEBAR_TOOLS = [
	"doc-openwith",
	"doc-presence",
	"sync-indicator",
	"theme-titlebar",
]

const EMPTY = "Open something from the project, or make something new."

const THEME: DockviewTheme = {
	...themeLight,
	name: "gaios",
	className: `${themeLight.className} projects__dock-theme`,
	gap: 8,
}

/** One of the dock's groups of tabs, named after what it shows. */
export type DockGroup = {id: string; title: string}

type Panel = {route: Accessor<ProjectRoute>; setRoute: Setter<ProjectRoute>}

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
	focus(panel: ProjectRoute | undefined): void
	/** where the dock's groups are offered, for opening into one */
	host: HTMLElement | undefined
}) {
	const panels = new Map<string, Panel>()
	const [groups, setGroups] = createSignal<DockGroup[]>([])
	let element!: HTMLDivElement
	let api: DockviewApi | undefined
	let count = 0

	onMount(() => {
		const dock = createDockview(element, {
			theme: THEME,
			disableFloatingGroups: true,
			createComponent: () => panelRenderer(),
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

	return <div ref={element} class="projects__dock" />

	function place(route: ProjectRoute) {
		if (!api) return
		const active = api.activePanel
		const target = groupTarget(api, route.placement)
		if (target) {
			panels.get(target.id)?.setRoute(route)
			target.api.setActive()
		} else if (!active) {
			if (route.resolved.docUrl) add(route)
		} else if (route.placement && "to" in route.placement) {
			add(route, beside(active.group, route.placement.to))
		} else {
			panels.get(active.id)?.setRoute(route)
		}
	}

	function add(route: ProjectRoute, position?: AddPanelPositionOptions) {
		const id = `panel-${++count}`
		const [shown, setShown] = createSignal(route)
		panels.set(id, {route: shown, setRoute: setShown})
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
						/>
					),
					element
				)
			},
			dispose: () => dispose?.(),
		}
	}
}

function DockPanel(props: {
	route: Accessor<ProjectRoute>
	repo: Repo
	draftKey: Accessor<string>
	setTitle(title: string): void
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
						<>
							<header class="projects__titlebar">
								<div class="projects__titlebar-tools">
									<For each={TITLEBAR_TOOLS}>
										{toolId => <patchwork-view tool-id={toolId} doc-url={url()} />}
									</For>
								</div>
							</header>
							<patchwork-view
								class="projects__document"
								doc-url={url()}
								tool-id={props.route().location.toolId}
							/>
						</>
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

function groupTarget(api: DockviewApi, placement: Placement | undefined) {
	if (!placement || !("group" in placement)) return undefined
	return api.getGroup(placement.group)?.activePanel
}

function beside(
	group: DockviewApi["groups"][number],
	to: Extract<Placement, {to: string}>["to"]
): AddPanelPositionOptions {
	return to === "tab"
		? {referenceGroup: group}
		: {referenceGroup: group, direction: to}
}

function watermark(): IWatermarkRenderer {
	const element = document.createElement("p")
	element.className = "projects__empty"
	element.textContent = EMPTY
	return {element, init() {}}
}
