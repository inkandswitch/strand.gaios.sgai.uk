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
	endsInFolder,
	findProject,
	projectRoot,
	relocate,
	resolveLocation,
	type FindDoc,
	type Resolved,
} from "./resolve.ts"
import type {SelectedView} from "./selection.ts"

export type ProjectRoute = {resolved: Resolved; location: Location}

export type Route =
	| {page: "loading"}
	| {page: "splash"}
	| ({page: "project"} & ProjectRoute)

/** The project whose drafts are mounted, and the draft to start it on. */
export type DraftScope = {projectUrl: AutomergeUrl; draft?: AutomergeUrl}

/** A mounted draft provider; its repo reads whichever draft is checked out. */
export type DraftProviderElement = HTMLElement & {repo: Repo}

export type Navigation = {
	route: Accessor<Route>
	project: Accessor<ProjectRoute | undefined>
	selectedView: Accessor<SelectedView | undefined>
	/** why the last thing asked for couldn't be opened */
	notice: Accessor<string | undefined>
	dismissNotice(): void
	open(url: string, toolId?: string | null): void
	home(): void
	/** where a draft provider should be mounted, if anywhere */
	scope: Accessor<DraftScope | undefined>
	/** the open project's repo, reading its checked-out draft */
	projectRepo: Accessor<Repo | undefined>
	/** the scope's provider has mounted; returns a detach */
	attach(projectUrl: AutomergeUrl, provider: DraftProviderElement): () => void
}

type HistoryMode = "push" | "replace"

type Attached = {
	projectUrl: AutomergeUrl
	provider: DraftProviderElement
	find: FindDoc
	/** the draft it was started on */
	initial: AutomergeUrl | null
	/** what it has checked out, once it has said */
	checkedOut: AutomergeUrl | null | undefined
	/** a switch navigation asked for, so it's not taken for the user's */
	switching: AutomergeUrl | null | undefined
}

/**
 * The frame's router. The hash says what's open; `patchwork:open-document`
 * events from anything inside `element` change it. Only locations inside a
 * project are opened, and a project has to be a folder.
 *
 * A project is seen through one of its drafts: the frame mounts a draft
 * provider for it (see `scope`), and everything in the project, paths
 * included, is looked up through that provider's repo. The hash's `draft=`
 * and the checked-out draft follow each other. Opening another project
 * starts it on main.
 */
export function createNavigation(element: HTMLElement, repo: Repo): Navigation {
	const find: FindDoc = async url => (await repo.find(url)).doc()
	const [route, setRoute] = createSignal<Route>({page: "loading"})
	const [notice, setNotice] = createSignal<string>()
	const [scope, setScope] = createSignal<DraftScope>()
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
			const url = current?.resolved.docUrl
			return url ? {url, toolId: current.location.toolId ?? null} : undefined
		},
		undefined,
		{equals: (a, b) => a?.url === b?.url && a?.toolId === b?.toolId}
	)

	const onOpen = (event: OpenDocumentEvent) => {
		event.stopPropagation()
		open(event.detail.url, event.detail.toolId)
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
		notice,
		dismissNotice: () => setNotice(undefined),
		open,
		home,
		scope,
		projectRepo,
		attach,
	}

	function open(url: string, toolId?: string | null) {
		const current = project()
		// The open document again, under another tool: "Open with".
		if (current && url === current.resolved.docUrl) {
			show(
				current.resolved,
				{...current.location, toolId: toolId ?? undefined},
				"push"
			)
			return
		}
		const location = parseLocationUrl(url)
		if (!location) {
			reject(new LocationError("not-a-project"), "push")
			return
		}
		// Within a project, stay in the draft it's on.
		const sameProject =
			current && current.resolved.projectUrl === projectUrlOf(location)
		void go(
			{
				...location,
				toolId: toolId ?? undefined,
				draft: sameProject ? current.location.draft : undefined,
			},
			"push"
		)
	}

	function home() {
		attempt++
		setNotice(undefined)
		setRoute({page: "splash"})
		setScope(undefined)
		write("", "push")
	}

	function followHash() {
		const hash = currentHash()
		written = hash
		if (!hash) {
			attempt++
			setRoute({page: "splash"})
			setScope(undefined)
			return
		}
		const location = parseHash(hash)
		if (location) void go(location, "replace")
		else reject(new LocationError("not-a-project"), "replace")
	}

	// Folders only expand in the tree, they never open. Asking to open one does
	// nothing; a hash naming one shows its project with nothing open.
	async function go(location: Location, mode: HistoryMode) {
		const mine = ++attempt
		const left = project()
		try {
			const projectUrl = await findProject(location, find)
			if (mine !== attempt) return
			const scoped = await enter(projectUrl, location.draft)
			if (mine !== attempt) return
			const draft = location.draft ?? null
			if (draft !== draftOf(scoped)) {
				scoped.switching = draft
				const selection = await request<{checkedOut: AutomergeUrl | null}>(
					scoped.provider,
					{type: "draft:select", checkedOut: draft, at: null}
				)
				scoped.checkedOut = selection.checkedOut
				if (mine !== attempt) return
			}
			const resolved = await resolveLocation(location, scoped.find)
			const folder = await endsInFolder(resolved, scoped.find)
			if (mine !== attempt) return
			const shown = {...location, draft: draftOf(scoped) ?? undefined}
			if (!folder) show(resolved, shown, mode)
			else if (mode === "replace") show(projectRoot(resolved), atRoot(shown), mode)
			else if (left?.resolved.projectUrl !== projectUrl) restore(left)
		} catch (error) {
			if (mine !== attempt) return
			if (mode === "push") restore(left)
			reject(error, mode)
		}
	}

	// Mount the project's draft provider, unless it's already there, and wait
	// for it.
	function enter(
		projectUrl: AutomergeUrl,
		draft: AutomergeUrl | undefined
	): Promise<Attached> {
		const current = attached()
		if (current?.projectUrl === projectUrl) return Promise.resolve(current)
		if (scope()?.projectUrl !== projectUrl) {
			waiting = []
			setScope({projectUrl, draft})
		}
		return new Promise(resolve => waiting.push(resolve))
	}

	// A push that didn't open anything leaves the project that was open.
	function restore(left: ProjectRoute | undefined) {
		if (scope()?.projectUrl === left?.resolved.projectUrl) return
		waiting = []
		setScope(
			left && {projectUrl: left.resolved.projectUrl, draft: left.location.draft}
		)
	}

	function attach(projectUrl: AutomergeUrl, provider: DraftProviderElement) {
		const scoped: Attached = {
			projectUrl,
			provider,
			find: async url => (await provider.repo.find(url)).doc(),
			initial: scope()?.draft ?? null,
			checkedOut: undefined,
			switching: undefined,
		}
		const unsubscribe = subscribe<{checkedOut: AutomergeUrl | null}>(
			provider,
			{type: "draft:selection"},
			selection => onDraftSelected(scoped, selection.checkedOut)
		)
		setAttached(scoped)
		const ready = waiting
		waiting = []
		for (const resolve of ready) resolve(scoped)
		return () => {
			unsubscribe()
			if (attached() === scoped) setAttached(undefined)
		}
	}

	// Someone picked another draft, or the one checked out went away: show
	// the same thing in it, or the project with nothing open if it isn't
	// there.
	function onDraftSelected(scoped: Attached, checkedOut: AutomergeUrl | null) {
		scoped.checkedOut = checkedOut
		if (scoped.switching === checkedOut) {
			scoped.switching = undefined
			return
		}
		const current = project()
		if (!current || current.resolved.projectUrl !== scoped.projectUrl) return
		if ((current.location.draft ?? null) === checkedOut) return
		const mine = ++attempt
		const location = {...current.location, draft: checkedOut ?? undefined}
		void relocate(current.resolved, scoped.find).then(
			next => {
				if (mine !== attempt) return
				if (next) show(next, location, "replace")
				else show(projectRoot(current.resolved), atRoot(location), "replace")
			},
			error => mine === attempt && reject(error, "replace")
		)
	}

	function show(resolved: Resolved, location: Location, mode: HistoryMode) {
		const canonical = {
			...location,
			segments: resolved.trail.map(step => step.segment),
		}
		setNotice(undefined)
		setRoute({page: "project", resolved, location: canonical})
		write(formatHash(canonical, resolved.projectName), mode)
	}

	// A failed open request leaves things as they were. A hash that can't be
	// followed goes back to the splash screen, so a reload doesn't repeat it.
	function reject(error: unknown, mode: HistoryMode) {
		const message =
			error instanceof LocationError ? error.message : String(error)
		console.warn("projects:", message)
		setNotice(message)
		if (mode === "push") return
		setRoute({page: "splash"})
		setScope(undefined)
		write("", "replace")
	}

	// Entries get renamed while they're open (sideboard names a document's
	// entry after its title), so watch the folders on the way to the open
	// document and keep the hash naming things as they're named now. One
	// that's gone (removed, or not in this draft) leaves the project open
	// with nothing in it.
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
					else if (!sameNames(next, resolved)) show(next, now.location, "replace")
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

/** The draft a provider is on, or is about to be on. */
function draftOf(scoped: Attached) {
	return scoped.checkedOut === undefined ? scoped.initial : scoped.checkedOut
}

function atRoot(location: Location): Location {
	return {...location, segments: [], heads: undefined, toolId: undefined}
}

function projectUrlOf(location: Location) {
	return `automerge:${location.projectId}` as AutomergeUrl
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
