import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {getRegistry, type DatatypeDescription} from "@inkandswitch/patchwork-plugins"
import {
	createSignal,
	createUniqueId,
	For,
	onCleanup,
	onMount,
	Show,
	type Accessor,
} from "solid-js"
import {useDoc} from "./hooks.ts"
import {
	createDocument,
	groupRecents,
	nameForNew,
	recentsOf,
	removeFromRecents,
	setPinned,
} from "./recents.ts"

/**
 * The account's roots beside whatever's open: a new one of any kind to make,
 * what's pinned, then the rest by when each was first opened, and the
 * packages page at the bottom.
 */
export function WorkspaceList(props: {
	recents: Accessor<DocHandle<FolderDoc> | undefined>
	repo: Repo
	/** the workspace that's open */
	current: AutomergeUrl | undefined
	/** folders on the list that aren't workspaces: the account's module settings */
	hidden: AutomergeUrl | undefined
	open(url: AutomergeUrl): void
	packages(): void
}) {
	const list = useDoc(props.recents)
	const groups = () =>
		groupRecents(recentsOf(list()).filter(recent => recent.url !== props.hidden))
	const [naming, setNaming] = createSignal(false)

	// A folder is named first; anything else is made straight away, named
	// after when it was made until it's given a name.
	function pick(type: string) {
		if (type === "folder") setNaming(true)
		else void create(type, nameForNew())
	}

	async function create(type: string, title?: string) {
		setNaming(false)
		try {
			props.open(await createDocument(props.repo, type, title))
		} catch (error) {
			console.error(`projects: couldn't make a ${type}`, error)
		}
	}

	function forget(url: AutomergeUrl) {
		const recents = props.recents()
		if (recents) removeFromRecents(recents, url)
	}

	function pin(url: AutomergeUrl, pinned: boolean) {
		const recents = props.recents()
		if (recents) setPinned(recents, url, pinned)
	}

	return (
		<aside class="projects__workspaces" aria-label="GAIOS">
			<header class="projects__workspaces-header">
				<h2 class="projects__label">GAIOS</h2>
				<NewMenu pick={pick} />
			</header>
			<Show when={naming()}>
				<NameInput
					class="projects__workspace-name"
					placeholder="Folder name"
					label="New folder name"
					commit={name => create("folder", name.trim() || "Untitled folder")}
					cancel={() => setNaming(false)}
				/>
			</Show>
			<div class="projects__workspace-groups">
				<For each={groups()}>
					{group => (
						<section class="projects__workspace-group" aria-label={group.label}>
							<h3 class="projects__workspace-group-label">{group.label}</h3>
							<ul class="projects__workspace-list">
								<For each={group.recents}>
									{workspace => (
										<li
											class="projects__workspace-item"
											classList={{
												"projects__workspace-item--current": workspace.url === props.current,
											}}>
											<button
												type="button"
												class="projects__workspace-open"
												aria-current={workspace.url === props.current ? "page" : undefined}
												onClick={() => props.open(workspace.url)}>
												{workspace.name || "Untitled"}
											</button>
											<button
												type="button"
												class="projects__workspace-action"
												classList={{"projects__workspace-action--on": workspace.pinned}}
												aria-pressed={workspace.pinned}
												title={workspace.pinned ? "Unpin" : "Pin"}
												aria-label={`${workspace.pinned ? "Unpin" : "Pin"} ${workspace.name}`}
												onClick={() => pin(workspace.url, !workspace.pinned)}>
												<PinIcon />
											</button>
											<button
												type="button"
												class="projects__workspace-action"
												title="Take off the list"
												aria-label={`Take ${workspace.name} off the list`}
												onClick={() => forget(workspace.url)}>
												×
											</button>
										</li>
									)}
								</For>
							</ul>
						</section>
					)}
				</For>
			</div>
			<footer class="projects__workspaces-footer">
				<button type="button" class="projects__workspace-new" onClick={() => props.packages()}>
					Packages
				</button>
			</footer>
		</aside>
	)
}

/** A plus, opening a menu of every kind of document there is to make. */
function NewMenu(props: {pick(type: string): void}) {
	const datatypes = useDatatypes()
	const menuId = createUniqueId()
	let button!: HTMLButtonElement
	let menu!: HTMLDivElement
	return (
		<>
			<button
				ref={button}
				type="button"
				class="projects__icon-button"
				aria-haspopup="menu"
				title="New"
				aria-label="New"
				popovertarget={menuId}>
				<PlusIcon />
			</button>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				role="menu"
				class="projects__open-with-menu"
				onBeforeToggle={event => {
					if (event.newState !== "open") return
					const box = button.getBoundingClientRect()
					menu.style.top = `${box.bottom + 4}px`
					menu.style.left = `${box.left}px`
				}}>
				<For each={datatypes()}>
					{datatype => (
						<button
							type="button"
							role="menuitem"
							class="projects__open-with-item"
							onClick={() => {
								menu.hidePopover()
								props.pick(datatype.id)
							}}>
							{datatype.name}
						</button>
					)}
				</For>
			</div>
		</>
	)
}

/** The datatypes there are to make, folders first, then by name. */
function useDatatypes() {
	const registry = getRegistry<DatatypeDescription>("patchwork:datatype")
	const listed = () =>
		registry
			.all()
			.filter(datatype => !datatype.unlisted)
			.sort((a, b) =>
				a.id === "folder" ? -1 : b.id === "folder" ? 1 : a.name.localeCompare(b.name)
			)
	const [datatypes, setDatatypes] = createSignal(listed())
	onCleanup(
		registry.on("changed", () => {
			setDatatypes(listed())
		})
	)
	return datatypes
}

/** A name typed in place: Enter or leaving it takes it, Escape doesn't. */
export function NameInput(props: {
	value?: string
	placeholder?: string
	label: string
	class: string
	commit(name: string): void
	cancel(): void
}) {
	let input!: HTMLInputElement
	let done = false
	const finish = (take: boolean) => {
		if (done) return
		done = true
		if (take && input.value.trim()) props.commit(input.value)
		else props.cancel()
	}
	onMount(() => {
		input.focus()
		input.select()
	})
	return (
		<input
			ref={input}
			class={props.class}
			value={props.value ?? ""}
			placeholder={props.placeholder}
			aria-label={props.label}
			onKeyDown={event => {
				if (event.key === "Enter") finish(true)
				else if (event.key === "Escape") {
					event.stopPropagation()
					finish(false)
				}
			}}
			onBlur={() => finish(true)}
		/>
	)
}

// lucide `pin`
function PinIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M12 17v5" />
			<path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
		</svg>
	)
}

// lucide `plus`
function PlusIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M5 12h14" />
			<path d="M12 5v14" />
		</svg>
	)
}

/** Whether the sidebar is open, and the switch for it. */
export type SidebarToggle = {open: boolean; toggle(): void}

/**
 * Shows or hides the sidebar, from the start of a card's header: it stays
 * there either way, so it doesn't move about.
 */
export function SidebarButton(props: {sidebar: SidebarToggle}) {
	return (
		<button
			type="button"
			class="projects__icon-button"
			aria-pressed={props.sidebar.open}
			title={props.sidebar.open ? "Hide sidebar" : "Show sidebar"}
			aria-label={props.sidebar.open ? "Hide sidebar" : "Show sidebar"}
			onClick={() => props.sidebar.toggle()}>
			<SidebarIcon />
		</button>
	)
}

// lucide `panel-left`
function SidebarIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round">
			<rect width="18" height="18" x="3" y="3" rx="2" />
			<path d="M9 3v18" />
		</svg>
	)
}
