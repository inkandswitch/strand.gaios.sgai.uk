import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {getType, type HasPatchworkMetadata} from "@inkandswitch/patchwork-filesystem"
import {getRegistry, type ToolDescription} from "@inkandswitch/patchwork-plugins"
import {
	createMemo,
	createSignal,
	createUniqueId,
	For,
	onCleanup,
	Show,
	type Accessor,
} from "solid-js"
import {useDoc, useHandle} from "./hooks.ts"

/**
 * The tool a document is shown with, named, opening a menu of the others
 * that show its type. Picking one is `pick`'s to carry out.
 */
export function OpenWith(props: {
	docUrl: AutomergeUrl
	repo: Repo
	/** the tool showing it, once it's mounted */
	toolId: string | undefined
	pick(toolId: string): void
}) {
	const doc = useDoc(useHandle<HasPatchworkMetadata>(props.repo, () => props.docUrl))
	const tools = useToolsFor(() => {
		const current = doc()
		return current && getType(current)
	})
	const current = () => tools().find(tool => tool.id === props.toolId)
	const [open, setOpen] = createSignal(false)
	const menuId = createUniqueId()
	let button!: HTMLButtonElement
	let menu!: HTMLDivElement

	return (
		<Show when={tools().length}>
			<button
				ref={button}
				type="button"
				class="projects__open-with"
				aria-haspopup="menu"
				aria-expanded={open()}
				title="Open with"
				popovertarget={menuId}>
				<span class="projects__open-with-name">{current()?.name ?? "Open with"}</span>
				<CaretIcon />
			</button>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				role="menu"
				class="projects__open-with-menu"
				onBeforeToggle={event => {
					if (event.newState === "open") placeUnder(button)
				}}
				onToggle={event => setOpen(event.newState === "open")}>
				<For each={tools()}>
					{tool => (
						<button
							type="button"
							role="menuitemradio"
							aria-checked={tool.id === props.toolId}
							class="projects__open-with-item"
							onClick={() => {
								menu.hidePopover()
								if (tool.id !== props.toolId) props.pick(tool.id)
							}}>
							<span class="projects__open-with-check">
								<Show when={tool.id === props.toolId}>
									<CheckIcon />
								</Show>
							</span>
							{tool.name}
						</button>
					)}
				</For>
			</div>
		</Show>
	)

	// A popover sits in the top layer, clear of the dock's clipping, so it's
	// placed against the button by hand: under it, right edges lined up.
	function placeUnder(anchor: HTMLElement) {
		const box = anchor.getBoundingClientRect()
		menu.style.top = `${box.bottom + 4}px`
		menu.style.right = `${window.innerWidth - box.right}px`
	}
}

/**
 * The tools listed for documents of `type`, the ones made for it ahead of
 * the ones that show anything, kept current as tools come and go.
 */
function useToolsFor(type: Accessor<string | undefined>): Accessor<ToolDescription[]> {
	const registry = getRegistry<ToolDescription>("patchwork:tool")
	const [version, setVersion] = createSignal(0)
	onCleanup(registry.on("changed", () => void setVersion(v => v + 1)))
	return createMemo(() => {
		version()
		const current = type()
		const listed = registry.filter(
			tool => !tool.unlisted && !tool.forTitleBar && shows(tool, current)
		)
		return listed.sort((a, b) => Number(isWildcard(a)) - Number(isWildcard(b)))
	})
}

function shows(tool: ToolDescription, type: string | undefined) {
	return isWildcard(tool) || (!!type && tool.supportedDatatypes.includes(type))
}

function isWildcard(tool: ToolDescription) {
	return tool.supportedDatatypes === "*" || tool.supportedDatatypes.includes("*")
}

// lucide `chevron-down`
export function CaretIcon() {
	return (
		<svg
			class="projects__open-with-caret"
			xmlns="http://www.w3.org/2000/svg"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="m6 9 6 6 6-6" />
		</svg>
	)
}

// lucide `check`
export function CheckIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M20 6 9 17l-5-5" />
		</svg>
	)
}
