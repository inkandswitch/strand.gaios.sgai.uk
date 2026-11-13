import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request, type Selector} from "@inkandswitch/patchwork-providers"
import {createSignal, createUniqueId, For, Show} from "solid-js"
import {CaretIcon, CheckIcon} from "./open-with.tsx"
import type {CompareAgainst, DraftEntry, DraftsState} from "./types.ts"
import {NameInput, SidebarIcon} from "./workspaces.tsx"

/**
 * The workspace card's header: its name, the draft that's checked out and
 * the one it's compared with, each picked from the tree of drafts, and a
 * menu of what to do with the checked-out draft.
 */
export function WorkspaceHeader(props: {
	name: string
	drafts: DraftsState | undefined
	/** what's compared with, previews included */
	against: CompareAgainst
	/** what's compared with once nothing's previewed */
	compared: AutomergeUrl | undefined
	/** inside the compare provider, where requests go from */
	element: HTMLElement
	toggleSidebar(): void
}) {
	const [renaming, setRenaming] = createSignal(false)
	const send = (selector: Selector) => void request(props.element, selector)
	const entries = () => props.drafts?.drafts ?? []
	const entry = (url: AutomergeUrl | undefined) =>
		url === undefined ? undefined : entries().find(draft => draft.url === url)
	const ours = () => entry(props.drafts?.checkedOut)
	const theirs = () => entry(props.against?.draft)

	return (
		<header class="projects__card-header">
			<button
				type="button"
				class="projects__icon-button"
				title="Workspaces"
				aria-label="Show or hide workspaces"
				onClick={() => props.toggleSidebar()}>
				<SidebarIcon />
			</button>
			<h1 class="projects__workspace-title">{props.name}</h1>
			<Show when={ours()}>
				{checkedOut => (
					<div class="projects__tokens">
						<Show
							when={!renaming()}
							fallback={
								<NameInput
									class="projects__token-rename"
									value={checkedOut().name}
									label="Draft name"
									commit={name => {
										setRenaming(false)
										send({type: "draft:rename", draft: checkedOut().url, name})
									}}
									cancel={() => setRenaming(false)}
								/>
							}>
							<DraftToken
								side="ours"
								entry={checkedOut()}
								entries={entries()}
								pick={draft => send({type: "draft:checkout", draft})}
							/>
						</Show>
						<Show when={theirs()}>
							{compared => (
								<>
									<span class="projects__tokens-between" aria-hidden="true">
										↔
									</span>
									<DraftToken
										side="theirs"
										entry={compared()}
										entries={entries()}
										previewing={props.against?.previewing}
										pick={draft => send({type: "compare:set", draft})}
										clear={() => send({type: "compare:set", draft: null})}
									/>
								</>
							)}
						</Show>
					</div>
				)}
			</Show>
			<Show when={ours()}>
				{checkedOut => (
					<DraftMenu
						ours={checkedOut()}
						entries={entries()}
						compared={props.compared}
						send={send}
						rename={() => setRenaming(true)}
					/>
				)}
			</Show>
		</header>
	)
}

/**
 * A draft as a token, opening the tree of drafts to pick another: the
 * checked-out one's in purple, the compared one's in coral with a × to stop
 * comparing, dashed while it's only previewed.
 */
function DraftToken(props: {
	side: "ours" | "theirs"
	entry: DraftEntry
	entries: DraftEntry[]
	previewing?: boolean
	pick(draft: AutomergeUrl): void
	clear?(): void
}) {
	const id = createUniqueId()
	let token!: HTMLDivElement
	let menu!: HTMLDivElement
	const parents = () => new Set(props.entries.map(entry => entry.parent))
	const pick = (draft: AutomergeUrl) => {
		menu.hidePopover()
		if (draft !== props.entry.url) props.pick(draft)
	}
	return (
		<div
			ref={token}
			class={`projects__token projects__token--${props.side}`}
			classList={{"projects__token--preview": props.previewing}}>
			<button
				type="button"
				class="projects__token-pick"
				aria-haspopup="menu"
				title={props.side === "ours" ? "Checked out" : "Compared with"}
				popovertarget={id}>
				<span class="projects__token-name">{props.entry.name}</span>
				<CaretIcon />
			</button>
			<Show when={props.clear}>
				{clear => (
					<button
						type="button"
						class="projects__token-clear"
						title="Stop comparing"
						aria-label="Stop comparing"
						onClick={() => clear()()}>
						×
					</button>
				)}
			</Show>
			<div
				ref={menu}
				id={id}
				popover="auto"
				role="menu"
				class="projects__menu"
				onBeforeToggle={event => {
					if (event.newState === "open") below(token, menu)
				}}>
				<p class="projects__menu-label">Drafts</p>
				<For each={props.entries}>
					{entry => (
						<button
							type="button"
							role="menuitemradio"
							aria-checked={entry.url === props.entry.url}
							class="projects__menu-item projects__tree-row"
							classList={{"projects__tree-row--parent": parents().has(entry.url)}}
							style={{"--depth": entry.depth}}
							onClick={() => pick(entry.url)}>
							<span class="projects__tree-guides" aria-hidden="true" />
							<span class="projects__menu-name">{entry.name}</span>
							<Show when={entry.url === props.entry.url}>
								<span class="projects__menu-check">
									<CheckIcon />
								</span>
							</Show>
						</button>
					)}
				</For>
			</div>
		</div>
	)
}

/**
 * What to do with the checked-out draft: compare it with another (hovering
 * one previews it), merge it into the draft it came from while that's what
 * it's compared with, make a draft from it, rename it, delete it.
 */
function DraftMenu(props: {
	ours: DraftEntry
	entries: DraftEntry[]
	compared: AutomergeUrl | undefined
	send(selector: Selector): void
	rename(): void
}) {
	const id = createUniqueId()
	const subId = createUniqueId()
	let button!: HTMLButtonElement
	let menu!: HTMLDivElement
	let sub!: HTMLDivElement
	let compareItem!: HTMLButtonElement
	const byUrl = (url: AutomergeUrl | null) =>
		url === null ? undefined : props.entries.find(entry => entry.url === url)
	const parent = () => byUrl(props.ours.parent)
	const others = () =>
		props.entries.filter(entry => entry.url !== props.ours.url && entry !== parent())
	const hasDrafts = () => props.entries.some(entry => entry.parent === props.ours.url)
	const close = () => menu.hidePopover()
	const preview = (draft: AutomergeUrl | null) =>
		props.send({type: "compare:preview", draft})

	const actions = {
		compare(draft: AutomergeUrl) {
			close()
			props.send({type: "compare:set", draft})
		},
		merge(into: DraftEntry) {
			close()
			if (!window.confirm(`Merge “${props.ours.name}” into “${into.name}”?`)) return
			props.send({type: "draft:merge", draft: props.ours.url})
		},
		create() {
			close()
			props.send({type: "draft:create", from: props.ours.url})
		},
		rename() {
			close()
			props.rename()
		},
		remove() {
			close()
			const warning = hasDrafts()
				? `Delete “${props.ours.name}” and the drafts made from it? This can't be undone.`
				: `Delete “${props.ours.name}”? This can't be undone.`
			if (window.confirm(warning)) props.send({type: "draft:delete", draft: props.ours.url})
		},
	}

	function openCompare() {
		if (sub.matches(":popover-open")) return
		const item = compareItem.getBoundingClientRect()
		const box = menu.getBoundingClientRect()
		sub.style.top = `${item.top - 4}px`
		sub.style.right = `${window.innerWidth - box.left + 4}px`
		sub.showPopover()
	}

	return (
		<>
			<button
				ref={button}
				type="button"
				class="projects__icon-button projects__more"
				title="Draft"
				aria-label="Draft menu"
				aria-haspopup="menu"
				popovertarget={id}>
				⋯
			</button>
			<div
				ref={menu}
				id={id}
				popover="auto"
				role="menu"
				class="projects__menu"
				onBeforeToggle={event => {
					if (event.newState === "open") below(button, menu)
				}}
				onToggle={event => {
					if (event.newState === "closed") preview(null)
				}}>
				<Show when={props.entries.length > 1}>
					<button
						ref={compareItem}
						type="button"
						role="menuitem"
						aria-haspopup="menu"
						class="projects__menu-item projects__menu-item--sub"
						onMouseEnter={openCompare}
						onClick={openCompare}>
						<ChevronIcon />
						Compare with
					</button>
				</Show>
				<Show when={parent() && props.compared === parent()!.url && parent()}>
					{into => (
						<button
							type="button"
							role="menuitem"
							class="projects__menu-item"
							onMouseEnter={() => sub.hidePopover()}
							onClick={() => actions.merge(into())}>
							Merge {props.ours.name} into {into().name}
						</button>
					)}
				</Show>
				<hr />
				<div onMouseEnter={() => sub.hidePopover()}>
					<button type="button" role="menuitem" class="projects__menu-item" onClick={actions.create}>
						New draft from {props.ours.name}
					</button>
					<button type="button" role="menuitem" class="projects__menu-item" onClick={actions.rename}>
						Rename {props.ours.name}
					</button>
					<Show when={parent()}>
						<button
							type="button"
							role="menuitem"
							class="projects__menu-item projects__menu-item--danger"
							onClick={actions.remove}>
							Delete {props.ours.name}
						</button>
					</Show>
				</div>

				<div
					ref={sub}
					id={subId}
					popover="auto"
					role="menu"
					class="projects__menu"
					onMouseLeave={() => preview(null)}>
					<p class="projects__menu-label">Compare {props.ours.name} with</p>
					<Show when={parent()}>
						{forkedFrom => (
							<>
								<CompareItem
									entry={forkedFrom()}
									meta="forked from"
									checked={props.compared === forkedFrom().url}
									preview={preview}
									pick={actions.compare}
								/>
								<hr />
							</>
						)}
					</Show>
					<For each={others()}>
						{entry => (
							<CompareItem
								entry={entry}
								meta={byUrl(entry.parent) && `from ${byUrl(entry.parent)!.name}`}
								checked={props.compared === entry.url}
								preview={preview}
								pick={actions.compare}
							/>
						)}
					</For>
				</div>
			</div>
		</>
	)
}

function CompareItem(props: {
	entry: DraftEntry
	meta: string | undefined
	checked: boolean
	preview(draft: AutomergeUrl): void
	pick(draft: AutomergeUrl): void
}) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={props.checked}
			class="projects__menu-item"
			onMouseEnter={() => props.preview(props.entry.url)}
			onClick={() => props.pick(props.entry.url)}>
			<span class="projects__menu-check projects__menu-check--before">
				<Show when={props.checked}>
					<CheckIcon />
				</Show>
			</span>
			<span class="projects__menu-name">{props.entry.name}</span>
			<Show when={props.meta}>
				<span class="projects__menu-meta">{props.meta}</span>
			</Show>
		</button>
	)
}

// Under `anchor`, lined up with its right edge: the header's menus are at
// the right of the window.
function below(anchor: HTMLElement, menu: HTMLElement) {
	const box = anchor.getBoundingClientRect()
	menu.style.top = `${box.bottom + 4}px`
	menu.style.right = `${Math.max(8, window.innerWidth - box.right)}px`
}

// lucide `chevron-left`, for a submenu that opens to the left
function ChevronIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="m15 18-6-6 6-6" />
		</svg>
	)
}
