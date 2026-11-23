import {parseAutomergeUrl, type AutomergeUrl} from "@automerge/automerge-repo/slim"
import {accept, subscribe, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
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
import {
	drawnByView,
	offered,
	optionsIn,
	type CompareSelector,
	type CompareView,
	type Mode,
	type Options,
	type Versions,
	type WorkspaceCompare,
} from "./compare.ts"
import {CollapseToggle, ComparePicker, ModeControls} from "./compare-ui.tsx"
import {OtherOverlay} from "./overlays.tsx"
import type {Member, Overlay} from "./types.ts"

/**
 * The version the checked-out one is compared with, B: views of it are
 * checked out of the root by an overlay provider of their own. `names` are
 * what A and B are called. `merging` while A is a merge and B its target:
 * then B is before and A after, and before comes first.
 */
export type Comparing = {
	root: AutomergeUrl
	b: Overlay
	names: {a: string; b: string}
	merging: boolean
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
					<Show when={props.picker !== false}>
						<ComparePicker
							modes={props.modes.offeredTo(props.panel)}
							current={mode()}
							title="Compare"
							pick={props.panel.setPicked}
						/>
					</Show>
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
				</>
			)}
		</Show>
	)
}

/**
 * A document, and while the checked-out overlay is compared with another
 * version, that version beside it, laid out by the compare mode, unless the
 * document's view draws the mode itself. The view showing the document stays
 * put as the mode changes, and is told the mode; a view drawing both versions
 * reads the other one itself.
 */
export function Compared(props: {
	url: AutomergeUrl
	toolId: string | undefined
	tool: Accessor<string | undefined>
	setTool(toolId: string | undefined): void
	compare: PanelCompare
}) {
	const [slotB, setSlotB] = createSignal<HTMLDivElement>()
	const [missing, setMissing] = createSignal(false)
	let host!: HTMLDivElement
	let slotA!: HTMLDivElement
	let view!: HTMLElement
	let viewB: HTMLElement | undefined
	const comparing = () => props.compare.comparing()
	const mode = () => (comparing() ? props.compare.mode() : undefined)
	const laidOut = () => {
		const current = mode()
		if (!current?.module.compose || drawnByView(current, props.compare.asked())) return
		return current
	}

	// Whether B has the document at all, laid out beside it.
	onMount(() => {
		createEffect(() => {
			const other = laidOut() && comparing()
			if (!other) return setMissing(false)
			const id = parseAutomergeUrl(props.url).documentId
			onCleanup(
				subscribe<Member[]>(host, {type: "overlay:members", overlay: other.b}, members =>
					setMissing(!members.some(member => parseAutomergeUrl(member.url).documentId === id))
				)
			)
		})
	})

	createEffect(() => {
		const current = laidOut()
		const b = slotB()
		if (!current || !b) return
		// A merge reads before (the target) to after: B, then A.
		const slots = comparing()?.merging ? {a: b, b: slotA} : {a: slotA, b}
		onCleanup(current.module.compose!(slots, props.compare.options(current), props.compare.versions()))
	})

	// Both versions' views are told the same: the mode, and its options.
	const told = new Set<(view: CompareView) => void>()
	let latest = (): CompareView => null
	createEffect(() => {
		const current = mode()
		const options = current && props.compare.options(current)
		const collapsed = props.compare.collapsed()
		latest = () =>
			current && options ? {mode: current.id, options: withCollapsed(options.current(), collapsed)} : null
		const tell = () => {
			for (const respond of told) respond(latest())
		}
		tell()
		if (options) onCleanup(options.subscribe(tell))
	})

	// Only the document's own views are told, A's and B's: views inside them
	// aren't comparing anything.
	const onSubscribe = (event: SubscribeEvent) => {
		const selector = event.detail.selector as CompareSelector
		if (selector.type !== "compare-mode:view") return
		const target = event.target as HTMLElement
		const own = target === view
		const other = target === viewB && !!slotB()?.contains(target)
		if (!own && !other) {
			if (slotB()?.contains(target)) accept<CompareView>(event, respond => respond(null))
			return
		}
		accept<CompareView>(event, respond => {
			if (own) props.compare.setAsked(selector)
			told.add(respond)
			respond(latest())
			return () => {
				told.delete(respond)
				if (own && props.compare.asked() === selector) props.compare.setAsked(undefined)
			}
		})
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
		<div
			ref={host}
			class="projects__compare"
			classList={{"projects__compare--merge": !!comparing()?.merging}}>
			<div ref={slotA} class="projects__compare-slot" data-version="a">
				<patchwork-view
					ref={reportTool}
					class="projects__document"
					doc-url={props.url}
					tool-id={props.toolId}
				/>
			</div>
			<Show when={laidOut() && comparing()}>
				{other => (
					<div ref={setSlotB} class="projects__compare-slot" data-version="b">
						<Show
							when={!missing()}
							fallback={<p class="projects__empty">Not in {other().names.b}</p>}>
							<Show when={other().b ?? "main"} keyed>
								{_overlay => (
									<OtherOverlay root={other().root} overlay={other().b}>
										<patchwork-view
											ref={element => (viewB = element)}
											class="projects__document"
											doc-url={props.url}
											tool-id={props.tool() ?? props.toolId}
										/>
									</OtherOverlay>
								)}
							</Show>
						</Show>
					</div>
				)}
			</Show>
		</div>
	)
}

// A mode's options, as a view is told them: with whether to fold what's
// unchanged away, where the options leave room for it.
function withCollapsed(options: unknown, collapsed: boolean): unknown {
	if (options === null || options === undefined) return {collapsed}
	if (typeof options === "object" && !Array.isArray(options)) return {...options, collapsed}
	return options
}
