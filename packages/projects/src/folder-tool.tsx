import type {AutomergeUrl, DocHandle} from "@automerge/automerge-repo/slim"
import type {ToolElement} from "@inkandswitch/patchwork-plugins"
import {createEffect, Show} from "solid-js"
import {render} from "solid-js/web"
import {Dock} from "./dock.tsx"
import {injectStyles} from "./styles.ts"
import {connectWorkspace} from "./workspace.ts"
import {useOverlayState} from "./overlay-state.ts"
import {versionKey} from "./types.ts"

/**
 * A folder as the root: its tree on the left and what's open in it tiled
 * beside it, documents and folders alike. What's open comes from the frame
 * around it (see `workspace.ts`); which overlay, and what it's compared
 * with, from the providers it's inside.
 */
export function renderFolderTool(handle: DocHandle<unknown>, element: ToolElement) {
	injectStyles()
	return render(() => <FolderWorkspace element={element} rootUrl={handle.url} />, element)
}

function FolderWorkspace(props: {element: ToolElement; rootUrl: AutomergeUrl}) {
	const workspace = connectWorkspace(props.element)
	const state = useOverlayState(
		() => props.element,
		() => true,
		() => props.rootUrl
	)
	createEffect(() => workspace.compare.setVersions(state.versions()))
	return (
		<div class="projects__body">
			<aside class="projects__files" aria-label="Files">
				<patchwork-view
					class="projects__panel"
					tool-id="chee/document-list"
					doc-url={props.rootUrl}
				/>
			</aside>
			{/* the comments and focus providers are the project card's, around this */}
			<main class="projects__main">
						<Show when={workspace.route() && state.overlays()}>
							<Dock
								route={workspace.route()!}
								repo={props.element.repo}
								overlayKey={versionKey(state.overlays()!)}
								overlays={state.overlays()!}
								comparing={state.comparing()}
								focus={workspace.focus}
								host={props.element}
								workspace={workspace.compare}
							/>
						</Show>
			</main>
		</div>
	)
}
