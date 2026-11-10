import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import type {FolderDoc} from "@inkandswitch/patchwork-filesystem"
import {createSignal, For, Show, type Accessor} from "solid-js"
import {folderLinks} from "./folders.ts"
import {useDoc} from "./hooks.ts"
import {createProject, removeFromRecents} from "./recents.ts"

/** Recent projects, most recently opened first, and a way to start a new one. */
export function Splash(props: {
	recents: Accessor<DocHandle<FolderDoc> | undefined>
	repo: Repo
	open(url: AutomergeUrl): void
}) {
	const list = useDoc(props.recents)
	const projects = () =>
		folderLinks(list()).filter(link => link.type === "folder")
	const [name, setName] = createSignal("")
	const [creating, setCreating] = createSignal(false)

	async function create(event: SubmitEvent) {
		event.preventDefault()
		setCreating(true)
		try {
			const url = await createProject(
				props.repo,
				name().trim() || "Untitled project"
			)
			setName("")
			props.open(url)
		} catch (error) {
			console.error("projects: couldn't create a project", error)
		} finally {
			setCreating(false)
		}
	}

	function forget(url: AutomergeUrl) {
		const recents = props.recents()
		if (recents) removeFromRecents(recents, url)
	}

	return (
		<div class="projects__splash">
			<h1 class="projects__splash-title">Projects</h1>
			<form class="projects__new" onSubmit={create}>
				<input
					class="projects__new-name"
					name="name"
					placeholder="New project name"
					aria-label="New project name"
					value={name()}
					onInput={event => setName(event.currentTarget.value)}
				/>
				<button type="submit" class="projects__button" disabled={creating()}>
					Create project
				</button>
			</form>
			<Show
				when={projects().length}
				fallback={<p class="projects__empty">No projects yet.</p>}>
				<ul class="projects__list">
					<For each={projects()}>
						{project => (
							<li class="projects__item">
								<button
									type="button"
									class="projects__open"
									onClick={() => props.open(project.url)}>
									{project.name || "Untitled project"}
								</button>
								<button
									type="button"
									class="projects__forget"
									title="Remove from recent projects"
									aria-label={`Remove ${project.name} from recent projects`}
									onClick={() => forget(project.url)}>
									×
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>
		</div>
	)
}
