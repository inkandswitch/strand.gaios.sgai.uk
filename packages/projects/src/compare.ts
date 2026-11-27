import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {
	getRegistry,
	type LoadedPlugin,
	type PluginDescription,
} from "@inkandswitch/patchwork-plugins"
import {createSignal, onCleanup, type Accessor} from "solid-js"

// The compare-modes package's plugin type, as this reads it.
export type CompareModeDescription = PluginDescription & {
	type: "patchwork:compare-mode"
	icon: string
	default?: boolean
}

export type CompareModeImplementation = {
	options?: unknown
	/** whether its options, and controls, are the workspace's or each panel's */
	scope?: "workspace" | "panel"
	compose?(
		slots: {a: HTMLElement; b: HTMLElement},
		options: Options<unknown>,
		versions?: Versions
	): () => void
	controls?(element: HTMLElement, options: Options<unknown>, versions?: Versions): () => void
}

/**
 * What the two versions are called and marked with: A the checked-out
 * overlay, B the one it's compared with.
 */
export type Versions = {a: Version; b: Version}
export type Version = {name: string; color: string}

export type Mode = LoadedPlugin<CompareModeDescription, CompareModeImplementation>

export type Options<O> = {
	current(): O
	set(next: O): void
	subscribe(listener: (options: O) => void): () => void
}

/**
 * What a view asks the panel showing it: `modes` turns modes on or off for
 * it, `draws` names the modes it draws itself though the panel could lay
 * them out, `collapses` the modes it can fold what's unchanged away in,
 * `prefers` the mode to start in.
 */
export type CompareSelector = {
	type: "compare-mode:view"
	modes?: Record<string, boolean>
	draws?: string[]
	collapses?: string[]
	prefers?: string
}

/**
 * What it's told while it's compared: the mode, and its options. In a mode
 * it collapses in, the options also say whether to fold what's unchanged
 * away (`collapsed`). Null while nothing is compared.
 */
export type CompareView = {mode: string; options: unknown} | null

/**
 * The compare modes a whole workspace shares. Picking one puts every panel
 * that takes it in it, and panels opened after start in it; a mode whose
 * options are the workspace's keeps one set for every panel. The dock says
 * which modes its panels take and which they're in.
 */
export type WorkspaceCompare = {
	/** the last pick: a new one each time, the same mode again included */
	picked: Accessor<{mode: string} | undefined>
	pick(mode: string): void
	options(mode: Mode): Options<unknown>
	/** a mode's options by its id, made from `defaults` the first time */
	optionsFor(id: string, defaults: unknown): Options<unknown>
	offered: Accessor<Mode[]>
	inUse: Accessor<Mode[]>
	report(offered: Mode[], inUse: Mode[]): void
	/** the two versions compared, while they are */
	versions: Accessor<Versions | undefined>
	setVersions(versions: Versions | undefined): void
}

export function createWorkspaceCompare(): WorkspaceCompare {
	const [picked, setPicked] = createSignal<{mode: string}>()
	const [offered, setOffered] = createSignal<Mode[]>([])
	const [inUse, setInUse] = createSignal<Mode[]>([])
	const [versions, setVersions] = createSignal<Versions | undefined>(undefined, {
		equals: (a, b) =>
			a?.a.name === b?.a.name &&
			a?.a.color === b?.a.color &&
			a?.b.name === b?.b.name &&
			a?.b.color === b?.b.color,
	})
	const kept = new Map<string, Options<unknown>>()
	return {
		picked,
		pick: mode => setPicked({mode}),
		options: mode => optionsIn(kept, mode),
		optionsFor: (id, defaults) => optionsById(kept, id, defaults),
		offered,
		inUse,
		report(nextOffered, nextInUse) {
			setOffered(previous => (sameModes(previous, nextOffered) ? previous : nextOffered))
			setInUse(previous => (sameModes(previous, nextInUse) ? previous : nextInUse))
		},
		versions,
		setVersions: next => setVersions(() => next),
	}
}

function sameModes(a: Mode[], b: Mode[]) {
	return a.length === b.length && a.every((mode, i) => mode === b[i])
}

/** The registered compare modes, loaded, kept current as packages come and go. */
export function useCompareModes(): Accessor<Mode[]> {
	const registry = getRegistry<CompareModeDescription>("patchwork:compare-mode")
	const [modes, setModes] = createSignal<Mode[]>([])
	let latest = 0
	const load = () => {
		const run = ++latest
		registry.loadAll(registry.all()).then(
			loaded => {
				if (run === latest) setModes(loaded as Mode[])
			},
			error => console.error("projects: couldn't load the compare modes", error)
		)
	}
	load()
	onCleanup(registry.on("changed", load))
	return modes
}

/** Whether `mode` is offered for a view that asked with `asked`. */
export function offered(mode: Mode, asked: CompareSelector | undefined) {
	const on = asked?.modes?.[mode.id] ?? mode.default ?? false
	return on && (!!mode.module.compose || drawnByView(mode, asked))
}

/** Whether the view draws `mode` itself, rather than the panel laying it out. */
export function drawnByView(mode: Mode, asked: CompareSelector | undefined) {
	if (!mode.module.compose) return asked?.modes?.[mode.id] === true
	return !!asked?.draws?.includes(mode.id)
}

/** A mode's options, made from its defaults the first time they're asked for. */
export function optionsIn(kept: Map<string, Options<unknown>>, mode: Mode) {
	return optionsById(kept, mode.id, mode.module.options)
}

function optionsById(kept: Map<string, Options<unknown>>, id: string, defaults: unknown) {
	let options = kept.get(id)
	if (!options) {
		options = createOptions(structuredClone(defaults ?? null))
		kept.set(id, options)
	}
	return options
}

export function createOptions<O>(initial: O): Options<O> {
	let value = initial
	const listeners = new Set<(options: O) => void>()
	return {
		current: () => value,
		set(next) {
			value = next
			for (const listener of listeners) listener(next)
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}
