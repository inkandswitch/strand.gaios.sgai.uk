import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {createSignal, For, onMount, Show, type Accessor} from "solid-js"
import {folderLinks} from "./folders.ts"
import {useDoc} from "./hooks.ts"
import {createWorkspace, removeFromRecents} from "./recents.ts"

/**
 * The account's workspaces, most recently opened first, beside whatever's
 * open: one to open, a new one to make, and the packages page at the bottom.
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
	collapse(): void
}) {
	const list = useDoc(props.recents)
	const workspaces = () =>
		folderLinks(list()).filter(
			link => link.type === "folder" && link.url !== props.hidden
		)
	const [naming, setNaming] = createSignal(false)

	async function create(name: string) {
		setNaming(false)
		try {
			props.open(await createWorkspace(props.repo, name.trim() || "Untitled workspace"))
		} catch (error) {
			console.error("projects: couldn't make a workspace", error)
		}
	}

	function forget(url: AutomergeUrl) {
		const recents = props.recents()
		if (recents) removeFromRecents(recents, url)
	}

	return (
		<aside class="projects__workspaces" aria-label="Workspaces">
			<header class="projects__workspaces-header">
				<h2 class="projects__label">Workspaces</h2>
				<button
					type="button"
					class="projects__icon-button"
					title="Hide workspaces"
					aria-label="Hide workspaces"
					onClick={() => props.collapse()}>
					<ChevronLeftIcon />
				</button>
			</header>
			<ul class="projects__workspace-list">
				<For each={workspaces()}>
					{workspace => (
						<li
							class="projects__workspace-item"
							classList={{"projects__workspace-item--current": workspace.url === props.current}}>
							<button
								type="button"
								class="projects__workspace-open"
								aria-current={workspace.url === props.current ? "page" : undefined}
								onClick={() => props.open(workspace.url)}>
								{workspace.name || "Untitled workspace"}
							</button>
							<button
								type="button"
								class="projects__workspace-forget"
								title="Take off the list"
								aria-label={`Take ${workspace.name} off the list`}
								onClick={() => forget(workspace.url)}>
								×
							</button>
						</li>
					)}
				</For>
			</ul>
			<Show
				when={naming()}
				fallback={
					<button type="button" class="projects__workspace-new" onClick={() => setNaming(true)}>
						+ New workspace
					</button>
				}>
				<NameInput
					class="projects__workspace-name"
					placeholder="Workspace name"
					label="New workspace name"
					commit={create}
					cancel={() => setNaming(false)}
				/>
			</Show>
			<footer class="projects__workspaces-footer">
				<button type="button" class="projects__workspace-new" onClick={() => props.packages()}>
					Packages
				</button>
			</footer>
		</aside>
	)
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

// lucide `chevron-left`
function ChevronLeftIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round">
			<path d="m15 18-6-6 6-6" />
		</svg>
	)
}

/** Brings the workspace list back, while it's collapsed: `show` is unset otherwise. */
export function ShowWorkspaces(props: {show: (() => void) | undefined}) {
	return (
		<Show when={props.show}>
			{show => (
				<button
					type="button"
					class="projects__icon-button"
					title="Show workspaces"
					aria-label="Show workspaces"
					onClick={() => show()()}>
					<SidebarIcon />
				</button>
			)}
		</Show>
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
