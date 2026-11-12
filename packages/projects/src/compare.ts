import {
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
	type UrlHeads,
} from "@automerge/automerge-repo/slim"
import {
	getRegistry,
	type LoadedPlugin,
	type PluginDescription,
} from "@inkandswitch/patchwork-plugins"
import {createEffect, createSignal, onCleanup, type Accessor} from "solid-js"

// The compare-modes package's plugin type, as this reads it.
export type CompareModeDescription = PluginDescription & {
	type: "patchwork:compare-mode"
	icon: string
	default?: boolean
}

export type CompareModeImplementation = {
	options?: unknown
	compose?(slots: {a: HTMLElement; b: HTMLElement}, options: Options<unknown>): () => void
	controls?(element: HTMLElement, options: Options<unknown>): () => void
}

export type Mode = LoadedPlugin<CompareModeDescription, CompareModeImplementation>

export type Options<O> = {
	current(): O
	set(next: O): void
	subscribe(listener: (options: O) => void): () => void
}

/**
 * What a view asks the panel showing it: `modes` turns modes on or off for
 * it, `draws` names the modes it draws itself though the panel could lay
 * them out.
 */
export type CompareSelector = {
	type: "compare:view"
	modes?: Record<string, boolean>
	draws?: string[]
}

/**
 * What it's told: the mode, its options, and the version it's compared
 * against; `created` when there's none because the draft made the document.
 */
export type CompareView = {
	base: AutomergeUrl | null
	created: boolean
	mode: string | null
	options: unknown
}

/** What a document is compared against on a draft. */
export type Base = {url: AutomergeUrl} | {created: true}

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
	let options = kept.get(mode.id)
	if (!options) {
		options = createOptions(structuredClone(mode.module.options ?? null))
		kept.set(mode.id, options)
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

// The parts of the drafts package's stored shapes read here.
type CloneEntry = {clonedAt: UrlHeads; cloneUrl?: AutomergeUrl}
type DraftDoc = {clones?: Record<AutomergeUrl, CloneEntry>}

/**
 * The version of the document at `docUrl` the checked-out draft started
 * from: undefined on main and while the draft hasn't changed it. The draft
 * repo reads the url at those heads from the draft's copy, which shares the
 * original's history.
 */
export function useBase(
	repo: Repo,
	draft: Accessor<string>,
	docUrl: Accessor<AutomergeUrl | undefined>
): Accessor<Base | undefined> {
	const [base, setBase] = createSignal<Base | undefined>(undefined, {equals: sameBase})
	createEffect(() => {
		const draftUrl = draft()
		const url = docUrl()
		setBase(undefined)
		if (draftUrl === "main" || !url) return
		const {documentId} = parseAutomergeUrl(url)
		const own = stringifyAutomergeUrl({documentId})
		let handle: DocHandle<DraftDoc> | undefined
		let cancelled = false
		const update = () => setBase(baseOf(own, handle?.doc()?.clones?.[own]))
		repo.find<DraftDoc>(draftUrl as AutomergeUrl).then(
			found => {
				if (cancelled) return
				handle = found
				found.on("change", update)
				update()
			},
			error => console.warn("projects: couldn't load the checked-out draft", error)
		)
		onCleanup(() => {
			cancelled = true
			handle?.off("change", update)
		})
	})
	return base
}

function baseOf(own: AutomergeUrl, entry: CloneEntry | undefined): Base | undefined {
	if (!entry?.cloneUrl) return undefined
	if (entry.clonedAt.length === 0) return {created: true}
	const {documentId} = parseAutomergeUrl(own)
	return {url: stringifyAutomergeUrl({documentId, heads: entry.clonedAt})}
}

function sameBase(a: Base | undefined, b: Base | undefined) {
	if (!a || !b) return a === b
	if ("created" in a || "created" in b) return "created" in a && "created" in b
	return a.url === b.url
}
