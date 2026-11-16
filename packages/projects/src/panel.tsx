import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {accept, subscribe, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
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
import {
	drawnByView,
	offered,
	optionsIn,
	type CompareSelector,
	type CompareView,
	type ComparedVersion,
	type Mode,
	type Options,
	type Versions,
	type WorkspaceCompare,
} from "./compare.ts"
import {CollapseToggle, ComparePicker, ModeControls} from "./compare-ui.tsx"
import {useMounted} from "./hooks.ts"

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

/**
 * One place a document is shown and compared: a panel of a folder's dock, or
 * a document that's the root on its own.
 */
export type PanelState = {
	/** what its document's view asked of the compare modes */
	asked: Accessor<CompareSelector | undefined>
	setAsked: Setter<CompareSelector | undefined>
	/** the compare mode picked for it, here or for the whole workspace */
	picked: Accessor<string | undefined>
	setPicked: Setter<string | undefined>
	/** its modes' options, for those whose options are each panel's */
	options: Map<string, Options<unknown>>
	/** what's unchanged folded away, in a mode its view can */
	collapsed: Accessor<boolean>
	setCollapsed: Setter<boolean>
}

export function createPanelState(): PanelState {
	const [asked, setAsked] = createSignal<CompareSelector>()
	const [picked, setPicked] = createSignal<string>()
	const [collapsed, setCollapsed] = createSignal(false)
	return {asked, setAsked, picked, setPicked, options: new Map(), collapsed, setCollapsed}
}

/** Its compare mode, worked out for a panel's view. */
export type PanelCompare = Pick<PanelState, "asked" | "setAsked"> & {
	comparing(): Comparing | undefined
	mode(): Mode | undefined
	options(mode: Mode): Options<unknown>
	collapsed(): boolean
	versions(): Versions | undefined
}

/** What a panel shows when its view prefers no mode it takes. */
const FALLBACK_MODE = "side-by-side"

export type PanelModes = ReturnType<typeof createPanelModes>

/**
 * How the compare modes apply to panels: which each is offered, which it's
 * in, and its options. Every panel follows the workspace's picks, and the
 * workspace hears which modes they offer and are in.
 */
export function createPanelModes(props: {
	modes: Accessor<Mode[]>
	workspace: WorkspaceCompare
	comparing: Accessor<Comparing | undefined>
	panels: Accessor<PanelState[]>
}) {
	const offeredTo = (panel: PanelState) =>
		props.modes().filter(mode => offered(mode, panel.asked()))

	// The one picked for it, else the one last picked for the workspace, else
	// the one its view prefers.
	const modeOf = (panel: PanelState) => {
		const list = offeredTo(panel)
		const wanted = [panel.picked(), props.workspace.picked()?.mode, panel.asked()?.prefers]
		for (const id of wanted) {
			const found = id && list.find(mode => mode.id === id)
			if (found) return found
		}
		return list.find(mode => mode.id === FALLBACK_MODE) ?? list[0]
	}

	const optionsOf = (panel: PanelState, mode: Mode) =>
		mode.module.scope === "workspace"
			? props.workspace.options(mode)
			: optionsIn(panel.options, mode)

	// Whether its view can fold what's unchanged away in `mode`.
	const collapses = (panel: PanelState, mode: Mode) =>
		!!panel.asked()?.collapses?.includes(mode.id)

	const compareOf = (panel: PanelState): PanelCompare => ({
		comparing: props.comparing,
		asked: panel.asked,
		setAsked: panel.setAsked,
		mode: () => modeOf(panel),
		options: mode => optionsOf(panel, mode),
		collapsed: () => {
			const mode = modeOf(panel)
			return !!mode && collapses(panel, mode) && panel.collapsed()
		},
		versions: props.workspace.versions,
	})

	// Picked for the whole workspace: every panel that takes it.
	createEffect(
		on(
			() => props.workspace.picked(),
			picked => {
				if (!picked) return
				for (const panel of props.panels()) {
					if (offeredTo(panel).some(mode => mode.id === picked.mode)) panel.setPicked(picked.mode)
				}
			},
			{defer: true}
		)
	)

	createEffect(() => {
		const list = props.comparing() ? props.panels() : []
		const all = props.modes()
		props.workspace.report(
			all.filter(mode => list.some(panel => offeredTo(panel).includes(mode))),
			all.filter(mode => list.some(panel => modeOf(panel) === mode))
		)
	})
	onCleanup(() => props.workspace.report([], []))

	return {offeredTo, modeOf, optionsOf, collapses, compareOf}
}

/**
 * A panel's own compare controls, while it's compared: its mode's controls
 * where they're the panel's, folding what's unchanged away where its view
 * can, and its mode.
 */
export function PanelCompareControls(props: {
	panel: PanelState
	modes: PanelModes
	comparing: boolean
	versions: Versions | undefined
	/** whether to offer picking its mode, where nothing else does */
	picker?: boolean
}) {
	return (
		<Show when={props.comparing && props.modes.modeOf(props.panel)}>
			{mode => (
				<>
					<Show when={mode().module.scope !== "workspace"}>
						<ModeControls
							mode={mode()}
							options={props.modes.optionsOf(props.panel, mode())}
							versions={props.versions}
						/>
					</Show>
					<Show when={props.modes.collapses(props.panel, mode())}>
						<CollapseToggle
							collapsed={props.panel.collapsed()}
							toggle={() => props.panel.setCollapsed(yn => !yn)}
						/>
					</Show>
					<Show when={props.picker !== false}>
						<ComparePicker
							modes={props.modes.offeredTo(props.panel)}
							current={mode()}
							title="Compare"
							versions={props.versions}
							pick={props.panel.setPicked}
						/>
					</Show>
				</>
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
export function Compared(props: {
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
		onCleanup(
			current.module.compose!({a: slotA, b}, props.compare.options(current), props.compare.versions())
		)
	})

	const told = new Set<(view: CompareView) => void>()
	let latest: () => CompareView = () => NOT_COMPARED
	createEffect(() => {
		const current = mode()
		const other = version()
		const options = current && props.compare.options(current)
		const collapsed = !!current && props.compare.collapsed()
		latest = () => ({
			mode: current?.id ?? null,
			options: options ? options.current() : null,
			other: current ? (other?.doc ?? null) : null,
			missing: !!current && other?.doc === null,
			collapsed,
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

const NOT_COMPARED: CompareView = {
	mode: null,
	options: null,
	other: null,
	missing: false,
	collapsed: false,
}
