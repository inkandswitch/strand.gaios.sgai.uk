import type {AutomergeUrl, DocHandle} from "@automerge/automerge-repo/slim"
import type {ToolElement} from "@inkandswitch/patchwork-plugins"
import {Show} from "solid-js"
import {render} from "solid-js/web"
import {Dock} from "./dock.tsx"
import {Provider} from "./provider.tsx"
import {injectStyles} from "./styles.ts"
import {connectWorkspace} from "./workspace.ts"
import {useWorkspaceState} from "./workspace-state.ts"

/**
 * A folder as the root: its tree on the left and its documents tiled beside
 * it. Folders only live in the tree, which opens and closes them; the dock
 * only ever holds documents. What's open, and which draft, comes from the
 * frame around it (see `workspace.ts`).
 */
export function renderFolderTool(handle: DocHandle<unknown>, element: ToolElement) {
	injectStyles()
	return render(() => <FolderWorkspace element={element} rootUrl={handle.url} />, element)
}

function FolderWorkspace(props: {element: ToolElement; rootUrl: AutomergeUrl}) {
	const workspace = connectWorkspace(props.element)
	const state = useWorkspaceState(
		() => props.element,
		() => true
	)
	return (
		<div class="projects__body">
			<aside class="projects__files" aria-label="Files">
				<patchwork-view
					class="projects__panel"
					tool-id="chee/document-list"
					doc-url={props.rootUrl}
				/>
			</aside>
			<Provider component="patchwork-comments-provider">
				<Provider component="patchwork-focus-provider">
					<main class="projects__main">
						<Show when={workspace.route() && state.drafts()}>
							<Dock
								route={workspace.route()!}
								repo={props.element.repo}
								draftKey={state.drafts()!.checkedOut}
								comparing={state.comparing()}
								focus={workspace.focus}
								host={props.element}
								workspace={workspace.compare}
							/>
						</Show>
					</main>
				</Provider>
			</Provider>
		</div>
	)
}
