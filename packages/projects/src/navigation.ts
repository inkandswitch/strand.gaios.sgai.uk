import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import type {OpenDocumentEvent} from "@inkandswitch/patchwork-elements"
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

export type Navigation = {
	route: Accessor<Route>
	project: Accessor<ProjectRoute | undefined>
	selectedView: Accessor<SelectedView | undefined>
	/** why the last thing asked for couldn't be opened */
	notice: Accessor<string | undefined>
	dismissNotice(): void
	open(url: string, toolId?: string | null): void
	home(): void
}

type HistoryMode = "push" | "replace"

/**
 * The frame's router. The hash says what's open; `patchwork:open-document`
 * events from anything inside `element` change it. Only locations inside a
 * project are opened, and a project has to be a folder.
 */
export function createNavigation(element: HTMLElement, repo: Repo): Navigation {
	const find: FindDoc = async url => (await repo.find(url)).doc()
	const [route, setRoute] = createSignal<Route>({page: "loading"})
	const [notice, setNotice] = createSignal<string>()
	let written: string | undefined
	let attempt = 0

	const project = createMemo(() => {
		const current = route()
		return current.page === "project" ? current : undefined
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
		void go({...location, toolId: toolId ?? undefined}, "push")
	}

	function home() {
		attempt++
		setNotice(undefined)
		setRoute({page: "splash"})
		write("", "push")
	}

	function followHash() {
		const hash = currentHash()
		written = hash
		if (!hash) {
			attempt++
			setRoute({page: "splash"})
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
		try {
			const resolved = await resolveLocation(location, find)
			const folder = await endsInFolder(resolved, find)
			if (mine !== attempt) return
			if (!folder) show(resolved, location, mode)
			else if (mode === "replace")
				show(
					projectRoot(resolved),
					{...location, segments: [], heads: undefined, toolId: undefined},
					mode
				)
		} catch (error) {
			if (mine === attempt) reject(error, mode)
		}
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
		write("", "replace")
	}

	// Entries get renamed while they're open (sideboard names a document's
	// entry after its title), so watch the folders on the way to the open
	// document and keep the hash naming things as they're named now.
	function followRenames() {
		createEffect(() => {
			const current = project()
			if (!current) return
			const {resolved} = current
			const folders = new Set<AutomergeUrl>([
				resolved.projectUrl,
				...resolved.trail.map(step => step.folderUrl),
			])
			let live = true
			const stops: (() => void)[] = []
			const refresh = () =>
				void relocate(resolved, find).then(next => {
					const now = project()
					if (!live || !next || now?.resolved !== resolved) return
					if (sameNames(next, resolved)) return
					show(next, now.location, "replace")
				})
			for (const url of folders) {
				void repo.find(url).then(handle => {
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
