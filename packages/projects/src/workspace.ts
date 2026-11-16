import {accept, request, subscribe, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, on, onCleanup, type Accessor} from "solid-js"
import {
	createOptions,
	type Mode,
	type Options,
	type Versions,
	type WorkspaceCompare,
} from "./compare.ts"
import type {ProjectRoute} from "./navigation.ts"

/*
 * How the frame and the root's tool talk, when the root lays out what's
 * open in it itself (a folder's tree and dock). The frame owns the hash and
 * the header; the tool owns the panels. Everything crossing is plain data:
 *
 *   - `workspace:route` → the route (what's open, and where an open asked
 *     for it to go), pushed on every change; null while there's none
 *   - `workspace:focus { route }` → another panel took focus, or the last
 *     one closed (null); answers true
 *   - `workspace:compare` → the mode last picked for every panel (with a
 *     count, so picking the same one again is told apart) and what the two
 *     versions are called, pushed on every change
 *   - `workspace:compare-options { mode, defaults }` → the options of a mode
 *     whose options are the workspace's, pushed on every change
 *   - `workspace:compare-set-options { mode, value }` → sets them; answers
 *     true
 *   - `workspace:compare-report { offered, inUse }` → the modes, by id, the
 *     panels offer and are in, for the header's picker; answers true
 */

type ComparePush = {picked: {mode: string; count: number} | null; versions: Versions | null}

/**
 * Answer the root's tool from `element`, which it's inside: the route, the
 * workspace's compare modes and their options, and what it reports back.
 */
export function provideWorkspace(
	element: HTMLElement,
	props: {
		route: Accessor<ProjectRoute | undefined>
		focus(route: ProjectRoute | undefined): void
		compare: WorkspaceCompare
		modes: Accessor<Mode[]>
	}
) {
	const routeListeners = new Set<(route: ProjectRoute | null) => void>()
	const compareListeners = new Set<(value: ComparePush) => void>()
	const [reported, setReported] = createSignal<{offered: string[]; inUse: string[]}>({
		offered: [],
		inUse: [],
	})
	let count = 0
	let picked: ComparePush["picked"] = null
	const compareNow = (): ComparePush => ({
		picked,
		versions: props.compare.versions() ?? null,
	})

	const onSubscribe = (event: SubscribeEvent) => {
		const selector = event.detail.selector as {type: string; [key: string]: unknown}
		switch (selector.type) {
			case "workspace:route":
				accept<ProjectRoute | null>(event, respond => {
					respond(plain(props.route()))
					routeListeners.add(respond)
					return () => routeListeners.delete(respond)
				})
				return
			case "workspace:focus":
				accept<boolean>(event, respond => {
					props.focus((selector.route as ProjectRoute | null) ?? undefined)
					respond(true)
				})
				return
			case "workspace:compare":
				accept<ComparePush>(event, respond => {
					respond(compareNow())
					compareListeners.add(respond)
					return () => compareListeners.delete(respond)
				})
				return
			case "workspace:compare-options": {
				if (typeof selector.mode !== "string") return
				const options = props.compare.optionsFor(selector.mode, selector.defaults)
				accept<unknown>(event, respond => {
					respond(options.current())
					return options.subscribe(respond)
				})
				return
			}
			case "workspace:compare-set-options":
				if (typeof selector.mode !== "string") return
				accept<boolean>(event, respond => {
					props.compare.optionsFor(selector.mode as string, null).set(selector.value)
					respond(true)
				})
				return
			case "workspace:compare-report":
				accept<boolean>(event, respond => {
					setReported({
						offered: ids(selector.offered),
						inUse: ids(selector.inUse),
					})
					respond(true)
				})
				return
		}
	}
	element.addEventListener("patchwork:subscribe", onSubscribe as EventListener)
	onCleanup(() => {
		element.removeEventListener("patchwork:subscribe", onSubscribe as EventListener)
		routeListeners.clear()
		compareListeners.clear()
	})

	createEffect(
		on(
			props.route,
			route => {
				for (const respond of routeListeners) respond(plain(route))
			},
			{defer: true}
		)
	)
	createEffect(
		on(
			() => props.compare.picked(),
			next => {
				picked = next ? {mode: next.mode, count: ++count} : null
			}
		)
	)
	createEffect(() => {
		props.compare.picked()
		props.compare.versions()
		const value = compareNow()
		for (const respond of compareListeners) respond(value)
	})
	// The modes are loaded here too: what's reported names them by id.
	createEffect(() => {
		const all = props.modes()
		const {offered, inUse} = reported()
		props.compare.report(
			all.filter(mode => offered.includes(mode.id)),
			all.filter(mode => inUse.includes(mode.id))
		)
	})
}

/**
 * The root's tool's side: the route, reporting focus back, and the
 * workspace's compare modes, as a `WorkspaceCompare` its panels can use the
 * same way the frame's own do.
 */
export function connectWorkspace(element: HTMLElement): {
	route: Accessor<ProjectRoute | undefined>
	focus(route: ProjectRoute | undefined): void
	compare: WorkspaceCompare
} {
	const [route, setRoute] = createSignal<ProjectRoute>()
	const [picked, setPicked] = createSignal<{mode: string}>()
	const [versions, setVersions] = createSignal<Versions>()
	const kept = new Map<string, Options<unknown>>()
	// Options are asked for from inside effects, but they're kept, and so is
	// their subscription, for as long as the tool is there.
	const stops: (() => void)[] = []
	onCleanup(() => {
		for (const stop of stops) stop()
	})
	let pickCount: number | undefined
	let lastReport = ""

	onCleanup(
		subscribe<ProjectRoute | null>(element, {type: "workspace:route"}, next =>
			setRoute(() => next ?? undefined)
		)
	)
	onCleanup(
		subscribe<ComparePush>(element, {type: "workspace:compare"}, next => {
			setVersions(() => next.versions ?? undefined)
			if (next.picked && next.picked.count !== pickCount) {
				pickCount = next.picked.count
				setPicked({mode: next.picked.mode})
			}
		})
	)

	const optionsFor = (id: string, defaults: unknown): Options<unknown> => {
		const found = kept.get(id)
		if (found) return found
		const local = createOptions<unknown>(structuredClone(defaults ?? null))
		const options: Options<unknown> = {
			current: local.current,
			subscribe: local.subscribe,
			set(next) {
				local.set(next)
				void request(element, {
					type: "workspace:compare-set-options",
					mode: id,
					value: next as never,
				})
			},
		}
		kept.set(id, options)
		stops.push(
			subscribe<any>(
				element,
				{type: "workspace:compare-options", mode: id, defaults: defaults as never},
				value => {
					if (JSON.stringify(value) !== JSON.stringify(local.current())) local.set(value)
				}
			)
		)
		return options
	}

	return {
		route,
		focus: next => void request(element, {type: "workspace:focus", route: plain(next)}),
		compare: {
			picked,
			pick: mode => setPicked({mode}),
			options: mode => optionsFor(mode.id, mode.module.options),
			optionsFor,
			offered: () => [],
			inUse: () => [],
			report(offered, inUse) {
				const next = {offered: offered.map(mode => mode.id), inUse: inUse.map(mode => mode.id)}
				const key = JSON.stringify(next)
				if (key === lastReport) return
				lastReport = key
				void request(element, {type: "workspace:compare-report", ...next})
			},
			versions,
			setVersions: next => setVersions(() => next),
		},
	}
}

// Routes cross as plain data: Solid's proxies and anything else that can't
// be cloned stay behind.
function plain(route: ProjectRoute | undefined): ProjectRoute | null {
	return route ? (JSON.parse(JSON.stringify(route)) as ProjectRoute) : null
}

function ids(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(id => typeof id === "string") : []
}
