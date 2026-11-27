import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import type {OpenDocumentEvent} from "@inkandswitch/patchwork-elements"
import {request, subscribe} from "@inkandswitch/patchwork-providers"
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	type Accessor,
} from "solid-js"
import {
	formatHash,
	parseHash,
	parseLocationUrl,
	type Location,
} from "./location.ts"
import {
	LocationError,
	findProject,
	projectRoot,
	relocate,
	resolveLocation,
	type FindDoc,
	type Resolved,
} from "./resolve.ts"
import type {SelectedView} from "./selection.ts"
import type {At, Overlay, OverlaysState} from "./types.ts"

/**
 * What's open in a project's focused panel. `placement` says where an open
 * asked for it to go; once the dock has put it there, the route it reports
 * back has none.
 */
export type ProjectRoute = {
	resolved: Resolved
	location: Location
	placement?: Placement
	/** asked for by an open, rather than landed on (see `nothingOpen`) */
	opened?: boolean
}

/**
 * Whether a route is a folder project with nothing open in it: its root,
 * landed on rather than opened. The root opens like any folder, but only
 * when it's asked for.
 */
export function nothingOpen(route: ProjectRoute): boolean {
	return !route.opened && route.resolved.root === "folder" && route.resolved.trail.length === 0
}

/**
 * Beside a group or in a new tab in it (the focused panel's group unless one
 * is named; last among its tabs unless `index` says where), along an edge of
 * the whole dock, or in place of what a group shows. Without one an open
 * replaces what the focused panel shows.
 */
export type Placement =
	| {to: Side; group?: string}
	| {to: "tab"; group?: string; index?: number}
	| {to: Side; edge: true}
	| {group: string}

export type Side = "right" | "left" | "above" | "below"

export type Route =
	| {page: "loading"}
	| {page: "home"}
	| {page: "packages"}
	| {page: "account"}
	| ({page: "project"} & ProjectRoute)

/**
 * The project whose overlays are mounted, and the overlay to start it on, at
 * a point in its history if `at` is set.
 */
export type OverlayScope = {projectUrl: AutomergeUrl; overlay?: AutomergeUrl; at?: string}

/** An overlay (null for main) at a point in its history (null for its working copy). */
type Version = {overlay: Overlay; at: At}

/** A mounted overlay provider; its repo reads whichever overlay is checked out. */
export type OverlayProviderElement = HTMLElement & {repo: Repo}

export type Navigation = {
	route: Accessor<Route>
	project: Accessor<ProjectRoute | undefined>
	selectedView: Accessor<SelectedView | undefined>
	open(url: string, toolId?: string | null, placement?: Placement): void
	/** another panel took focus, or the last one closed */
	focus(panel: ProjectRoute | undefined): void
	/**
	 * the open project is compared with another of its overlays or main, or
	 * a point in one's history, or isn't
	 */
	compare(overlay: Overlay | undefined, at?: At): void
	/** the page for installing packages: tools, datatypes */
	packages(): void
	/** the page for the account: who's signed in, signing in and out */
	account(): void
	/** where an overlay provider should be mounted, if anywhere */
	scope: Accessor<OverlayScope | undefined>
	/** the open project's repo, reading its checked-out overlay */
	projectRepo: Accessor<Repo | undefined>
	/** the scope's provider has mounted; returns a detach */
	attach(projectUrl: AutomergeUrl, provider: OverlayProviderElement): () => void
}

type HistoryMode = "push" | "replace"

const PACKAGES_HASH = "packages"
const ACCOUNT_HASH = "account"

type Attached = {
	projectUrl: AutomergeUrl
	provider: OverlayProviderElement
	find: FindDoc
	/** the version it was started on */
	initial: Version
	/** what it has checked out, once it has said */
	checkedOut: Version | undefined
	/** a switch navigation asked for, so it's not taken for the user's */
	switching: Version | undefined
}

/**
 * The frame's router. The hash says what's open; `patchwork:open-document`
 * events from anything inside `element` change it. A location's first
 * document is its project, the root, whatever it is: a folder, with
 * documents open in it, or any other document, open on its own.
 *
 * A project is seen through one of its overlays, or main: the frame mounts
 * an overlay provider for it (see `scope`), and everything in the project,
 * paths included, is looked up through that provider's repo. The hash's
 * `overlay=` and `at=` and the checked-out version follow each other, and
 * `compare=` and `compare-at=` and what it's compared with. Opening another
 * project starts it on main.
 */
export function createNavigation(element: HTMLElement, repo: Repo): Navigation {
	const find: FindDoc = async url => (await repo.find(url)).doc()
	const [route, setRoute] = createSignal<Route>({page: "loading"})
	const [scope, setScope] = createSignal<OverlayScope>()
	const [attached, setAttached] = createSignal<Attached>()
	let waiting: ((attached: Attached) => void)[] = []
	let written: string | undefined
	let attempt = 0

	const project = createMemo(() => {
		const current = route()
		return current.page === "project" ? current : undefined
	})
	const projectRepo = createMemo(() => {
		const current = attached()
		return current && current.projectUrl === project()?.resolved.projectUrl
			? current.provider.repo
			: undefined
	})
	const selectedView = createMemo<SelectedView | undefined>(
		() => {
			const current = project()
			return current && !nothingOpen(current)
				? {url: current.resolved.docUrl, toolId: current.location.toolId ?? null}
				: undefined
		},
		undefined,
		{equals: (a, b) => a?.url === b?.url && a?.toolId === b?.toolId}
	)

	const onOpen = (event: OpenDocumentEvent) => {
		event.stopPropagation()
		open(event.detail.url, event.detail.toolId, placementOf(event.detail))
	}
	const onHistory = () => {
		if (currentHash() !== written) followHash()
	}
	element.addEventListener("patchwork:open-document", onOpen as EventListener)
	window.addEventListener("hashchange", onHistory)
	window.addEventListener("popstate", onHistory)
	onCleanup(() => {
		element.removeEventListener(
			"patchwork:open-document",
			onOpen as EventListener
		)
		window.removeEventListener("hashchange", onHistory)
		window.removeEventListener("popstate", onHistory)
	})

	followRenames()
	followHash()

	return {
		route,
		project,
		selectedView,
		open,
		focus,
		compare,
		packages,
		account,
		scope,
		projectRepo,
		attach,
	}

	function open(url: string, toolId?: string | null, placement?: Placement) {
		const current = project()
		// The open document again, under another tool: "Open with".
		if (current && url === current.resolved.docUrl) {
			show(
				current.resolved,
				{...current.location, toolId: toolId ?? undefined},
				"push",
				placement
			)
			return
		}
		const location = parseLocationUrl(url)
		if (!location) {
			reject(new LocationError("not-a-project"), "push")
			return
		}
		// Within a project, stay in the overlay it's on, compared as it is.
		const sameProject =
			current && current.resolved.projectUrl === projectUrlOf(location)
		void go(
			{
				...location,
				toolId: toolId ?? undefined,
				...(sameProject ? versionsOf(current.location) : {}),
			},
			"push",
			sameProject ? placement : undefined
		)
	}

	// The hash follows the focused panel, so going back and forth between
	// panels doesn't pile up history. Each panel keeps the place it was given,
	// but they're all on the overlay that's checked out.
	function focus(panel: ProjectRoute | undefined) {
		const current = project()
		if (!current) return
		if (!panel) {
			show(projectRoot(current.resolved), atRoot(current.location), "replace")
			return
		}
		if (panel.resolved.projectUrl !== current.resolved.projectUrl) return
		if (samePlace(panel, current)) return
		attempt++
		show(
			panel.resolved,
			{
				...panel.location,
				overlay: undefined,
				at: undefined,
				compare: undefined,
				compareAt: undefined,
				...versionsOf(current.location),
			},
			"replace",
			undefined,
			panel.opened
		)
	}

	function compare(overlay: Overlay | undefined, at: At = null) {
		const current = project()
		const compareAt = overlay === undefined ? undefined : (at ?? undefined)
		if (!current) return
		if (current.location.compare === overlay && current.location.compareAt === compareAt) return
		show(current.resolved, {...current.location, compare: overlay, compareAt}, "replace", undefined, current.opened)
	}

	function packages() {
		leave("packages")
		write(PACKAGES_HASH, "push")
	}

	function account() {
		leave("account")
		write(ACCOUNT_HASH, "push")
	}

	// To a page outside any project, unmounting its overlays.
	function leave(page: "home" | "packages" | "account") {
		attempt++
		setRoute({page})
		setScope(undefined)
	}

	function followHash() {
		const hash = currentHash()
		written = hash
		if (!hash) return leave("home")
		if (hash === PACKAGES_HASH) return leave("packages")
		if (hash === ACCOUNT_HASH) return leave("account")
		const location = parseHash(hash)
		if (location) void go(location, "replace")
		else reject(new LocationError("not-a-project"), "replace")
	}

	// Anything in the project opens, folders and the project itself included:
	// a folder is shown like any other document (see `folder-panel.tsx`).
	async function go(
		location: Location,
		mode: HistoryMode,
		placement?: Placement
	) {
		const mine = ++attempt
		const left = project()
		try {
			const projectUrl = await findProject(location, find)
			if (mine !== attempt) return
			const scoped = await enter(projectUrl, location.overlay, location.at)
			if (mine !== attempt) return
			const wanted: Version = {overlay: location.overlay ?? null, at: location.at ?? null}
			if (!sameVersion(wanted, versionOf(scoped))) {
				scoped.switching = wanted
				const done = await request<true | null>(scoped.provider, {
					type: "overlay:checkout",
					overlay: wanted.overlay,
					at: wanted.at,
				})
				if (done) scoped.checkedOut = wanted
				scoped.switching = undefined
				if (mine !== attempt) return
			}
			const resolved = await resolveLocation(location, scoped.find)
			if (mine !== attempt) return
			const now = versionOf(scoped)
			show(resolved, {...location, overlay: now.overlay ?? undefined, at: now.at ?? undefined}, mode, placement)
		} catch (error) {
			if (mine !== attempt) return
			if (mode === "push") restore(left)
			reject(error, mode)
		}
	}

	// Mount the project's overlay provider, unless it's already there, and
	// wait for it.
	function enter(
		projectUrl: AutomergeUrl,
		overlay: AutomergeUrl | undefined,
		at: string | undefined
	): Promise<Attached> {
		const current = attached()
		if (current?.projectUrl === projectUrl) return Promise.resolve(current)
		if (scope()?.projectUrl !== projectUrl) {
			waiting = []
			setScope({projectUrl, overlay, at})
		}
		return new Promise(resolve => waiting.push(resolve))
	}

	// A push that didn't open anything leaves the project that was open.
	function restore(left: ProjectRoute | undefined) {
		if (scope()?.projectUrl === left?.resolved.projectUrl) return
		waiting = []
		setScope(
			left && {
				projectUrl: left.resolved.projectUrl,
				overlay: left.location.overlay,
				at: left.location.at,
			}
		)
	}

	function attach(projectUrl: AutomergeUrl, provider: OverlayProviderElement) {
		const scoped: Attached = {
			projectUrl,
			provider,
			find: async url => (await provider.repo.find(url)).doc(),
			initial: {overlay: scope()?.overlay ?? null, at: scope()?.at ?? null},
			checkedOut: undefined,
			switching: undefined,
		}
		const unsubscribe = subscribe<OverlaysState>(provider, {type: "overlays"}, state => {
			if (state.status !== "loading")
				onOverlaySelected(scoped, {overlay: state.checkedOut, at: state.at ?? null})
		})
		setAttached(scoped)
		const ready = waiting
		waiting = []
		for (const resolve of ready) resolve(scoped)
		return () => {
			unsubscribe()
			if (attached() === scoped) setAttached(undefined)
		}
	}

	// Someone picked another version, or the one checked out went away: show
	// the same thing in it, or the project itself if it isn't there.
	function onOverlaySelected(scoped: Attached, checkedOut: Version) {
		if (scoped.checkedOut && sameVersion(scoped.checkedOut, checkedOut)) return
		scoped.checkedOut = checkedOut
		if (scoped.switching && sameVersion(scoped.switching, checkedOut)) return
		const current = project()
		if (!current || current.resolved.projectUrl !== scoped.projectUrl) return
		const shown = {overlay: current.location.overlay ?? null, at: current.location.at ?? null}
		if (sameVersion(shown, checkedOut)) return
		const mine = ++attempt
		const location = {
			...current.location,
			overlay: checkedOut.overlay ?? undefined,
			at: checkedOut.at ?? undefined,
		}
		void relocate(current.resolved, scoped.find).then(
			next => {
				if (mine !== attempt) return
				if (next) show(next, location, "replace", undefined, current.opened)
				else show(projectRoot(current.resolved), atRoot(location), "replace")
			},
			error => mine === attempt && reject(error, "replace")
		)
	}

	// What an open pushes was asked for; what's replaced was landed on,
	// unless it says it was opened.
	function show(
		resolved: Resolved,
		location: Location,
		mode: HistoryMode,
		placement?: Placement,
		opened = mode === "push"
	) {
		const canonical = {
			...location,
			segments: resolved.trail.map(step => step.segment),
		}
		setRoute({page: "project", resolved, location: canonical, placement, opened})
		write(formatHash(canonical, resolved.projectName), mode)
	}

	// A link that goes nowhere is ignored: what's open stays open. A hash
	// that can't be followed goes back home, so a reload doesn't repeat it.
	function reject(error: unknown, mode: HistoryMode) {
		const message =
			error instanceof LocationError ? error.message : String(error)
		console.warn("projects:", message)
		if (mode === "push") return
		setRoute({page: "home"})
		setScope(undefined)
		write("", "replace")
	}

	// Entries get renamed while they're open (sideboard names a document's
	// entry after its title), so watch the folders on the way to the open
	// document and keep the hash naming things as they're named now. One
	// that's gone (removed, or not in this overlay) leaves the project itself
	// open.
	function followRenames() {
		createEffect(() => {
			const current = project()
			const scoped = attached()
			if (!current || scoped?.projectUrl !== current.resolved.projectUrl) return
			const {resolved} = current
			const folders = new Set<AutomergeUrl>([
				resolved.projectUrl,
				...resolved.trail.map(step => step.folderUrl),
			])
			let live = true
			const stops: (() => void)[] = []
			const refresh = () =>
				void relocate(resolved, scoped.find).then(next => {
					const now = project()
					if (!live || now?.resolved !== resolved) return
					if (!next) show(projectRoot(resolved), atRoot(now.location), "replace")
					else if (!sameNames(next, resolved)) show(next, now.location, "replace", undefined, now.opened)
				})
			for (const url of folders) {
				void scoped.provider.repo.find(url).then(handle => {
					if (!live) return
					handle.on("change", refresh)
					stops.push(() => handle.off("change", refresh))
				})
			}
			onCleanup(() => {
				live = false
				for (const stop of stops) stop()
			})
		})
	}

	function write(hash: string, mode: HistoryMode) {
		const target = normalizeHash(hash)
		written = target
		if (target === currentHash()) return
		const url = target ? `#${target}` : location.pathname + location.search
		if (mode === "push") history.pushState(null, "", url)
		else history.replaceState(null, "", url)
	}
}

/** The version a provider is on, or is about to be on. */
function versionOf(scoped: Attached): Version {
	return scoped.checkedOut ?? scoped.initial
}

function sameVersion(a: Version, b: Version) {
	return a.overlay === b.overlay && a.at === b.at
}

/** What a location is seen in and compared with, to carry over to another. */
function versionsOf(location: Location): Partial<Location> {
	return {
		overlay: location.overlay,
		at: location.at,
		compare: location.compare,
		compareAt: location.compareAt,
	}
}

function atRoot(location: Location): Location {
	return {...location, segments: [], heads: undefined, toolId: undefined}
}

function projectUrlOf(location: Location) {
	return `automerge:${location.projectId}` as AutomergeUrl
}

function samePlace(a: ProjectRoute, b: ProjectRoute) {
	return (
		a.resolved.docUrl === b.resolved.docUrl &&
		a.location.toolId === b.location.toolId &&
		sameNames(a.resolved, b.resolved)
	)
}

// Open events come from any tool, so their placement is checked, not trusted.
function placementOf(detail: object): Placement | undefined {
	const placement = "placement" in detail ? detail.placement : undefined
	if (!placement || typeof placement !== "object") return undefined
	const group =
		"group" in placement && typeof placement.group === "string"
			? placement.group
			: undefined
	if (!("to" in placement)) return group ? {group} : undefined
	const to = placement.to
	if (to === "tab") {
		const index =
			"index" in placement &&
			Number.isInteger(placement.index) &&
			(placement.index as number) >= 0
				? (placement.index as number)
				: undefined
		return {to, ...(group ? {group} : {}), ...(index === undefined ? {} : {index})}
	}
	if (!isSide(to)) return undefined
	if ("edge" in placement && placement.edge === true) return {to, edge: true}
	return group ? {to, group} : {to}
}

const SIDES: readonly unknown[] = ["right", "left", "above", "below"]

function isSide(value: unknown): value is Side {
	return SIDES.includes(value)
}

function sameNames(a: Resolved, b: Resolved) {
	return (
		a.projectName === b.projectName &&
		a.trail.every((step, index) => step.segment === b.trail[index]?.segment)
	)
}

function currentHash() {
	return location.hash.slice(1)
}

// The browser percent-encodes some characters in the hash (non-ASCII letters
// in a slug, say), so compare hashes the way it will store them.
function normalizeHash(hash: string) {
	return hash ? new URL(`#${hash}`, location.href).hash.slice(1) : ""
}
