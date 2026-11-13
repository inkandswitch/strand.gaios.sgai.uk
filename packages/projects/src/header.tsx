import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request, subscribe, type Selector} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, createUniqueId, For, onCleanup, Show, type JSX} from "solid-js"
import {CaretIcon, CheckIcon} from "./open-with.tsx"
import type {CompareAgainst, CompareChanges, DraftEntry, DraftsState, Mark} from "./types.ts"
import {NameInput, ShowWorkspaces} from "./workspaces.tsx"

/**
 * The workspace card's header: its name, then the checked-out draft as a
 * token opening everything to do with drafts, and the draft it's compared
 * with beside it.
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
	/** unset while the workspace list is shown */
	showSidebar: (() => void) | undefined
}) {
	const [renaming, setRenaming] = createSignal(false)
	const [changes, setChanges] = createSignal<CompareChanges>()
	const send = (selector: Selector) => void request(props.element, selector)
	const entries = () => props.drafts?.drafts ?? []
	const entry = (url: AutomergeUrl | undefined) =>
		url === undefined ? undefined : entries().find(draft => draft.url === url)
	const ours = () => entry(props.drafts?.checkedOut)
	const theirs = () => entry(props.against?.draft)

	createEffect(() => {
		const element = props.element
		onCleanup(
			subscribe<CompareChanges>(element, {type: "compare:changes"}, value => setChanges(value))
		)
	})

	// What comparing with `draft` turned up, once it's what's compared with.
	const difference = (draft: AutomergeUrl) => {
		const found = changes()
		if (props.against?.draft !== draft || found?.status !== "ready") return undefined
		const count = Object.keys(found.files).length
		if (count === 0) return "no differences"
		return count === 1 ? "1 file differs" : `${count} files differ`
	}

	const merging = () => {
		const from = ours()
		const into = theirs()
		return props.against?.merging && from && into ? {from, into} : undefined
	}

	return (
		<header class="projects__card-header">
			<ShowWorkspaces show={props.showSidebar} />
			<h1 class="projects__workspace-title">{props.name}</h1>
			<Show when={merging()}>
				{merge => (
					<MergeBar
						from={merge().from}
						into={merge().into}
						changes={changes()}
						element={props.element}
					/>
				)}
			</Show>
			<Show when={!merging() && ours()}>
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
							<DraftMenu
								ours={checkedOut()}
								entries={entries()}
								comparing={theirs() !== undefined}
								compared={props.compared}
								difference={difference}
								send={send}
								rename={() => setRenaming(true)}
							/>
						</Show>
						<Show when={theirs()}>
							{compared => (
								<>
									<span class="projects__tokens-between" aria-hidden="true">
										↔
									</span>
									<span
										class="projects__token projects__token--theirs"
										classList={{"projects__token--preview": props.against?.previewing}}
										title="Compared with">
										<span class="projects__token-dot" aria-hidden="true" />
										<span class="projects__token-name">{compared().name}</span>
										<button
											type="button"
											class="projects__token-clear"
											title="Stop comparing"
											aria-label="Stop comparing"
											onClick={() => send({type: "compare:set", draft: null})}>
											×
										</button>
									</span>
								</>
							)}
						</Show>
					</div>
				)}
			</Show>
		</header>
	)
}

/**
 * The checked-out draft's token, opening the drafts to check out another,
 * and what to do with this one: compare it with another or merge it into
 * one (hovering either previews the comparison), copy it, rename it, delete
 * it. Both lists start with the draft it was copied from.
 */
function DraftMenu(props: {
	ours: DraftEntry
	entries: DraftEntry[]
	comparing: boolean
	compared: AutomergeUrl | undefined
	difference(draft: AutomergeUrl): string | undefined
	send(selector: Selector): void
	rename(): void
}) {
	const id = createUniqueId()
	const compareId = createUniqueId()
	const mergeId = createUniqueId()
	let token!: HTMLButtonElement
	let menu!: HTMLDivElement
	let compareMenu!: HTMLDivElement
	let mergeMenu!: HTMLDivElement
	let compareItem!: HTMLButtonElement
	let mergeItem!: HTMLButtonElement
	const byUrl = (url: AutomergeUrl | null) =>
		url === null ? undefined : props.entries.find(entry => entry.url === url)
	const copiedFrom = (entry: DraftEntry) => {
		const parent = byUrl(entry.parent)
		return parent && `copied from ${parent.name}`
	}
	const parent = () => byUrl(props.ours.parent)
	const others = () =>
		props.entries.filter(entry => entry.url !== props.ours.url && entry !== parent())
	const forkedFromOurs = (entry: DraftEntry): boolean => {
		const up = byUrl(entry.parent)
		return up !== undefined && (up.url === props.ours.url || forkedFromOurs(up))
	}
	const mergeTargets = () => others().filter(entry => !forkedFromOurs(entry))
	const hasDrafts = () => props.entries.some(entry => entry.parent === props.ours.url)
	const [submenu, setSubmenu] = createSignal<"compare" | "merge">()
	const toggled = (which: "compare" | "merge") => (open: boolean) =>
		setSubmenu(current => (open ? which : current === which ? undefined : current))
	const close = () => menu.hidePopover()
	const preview = (draft: AutomergeUrl | null) =>
		props.send({type: "compare:preview", draft})
	const closeSubmenus = () => {
		compareMenu.hidePopover()
		mergeMenu.hidePopover()
	}

	const actions = {
		checkout(draft: AutomergeUrl) {
			close()
			if (draft !== props.ours.url) props.send({type: "draft:checkout", draft})
		},
		compare(draft: AutomergeUrl) {
			close()
			props.send({type: "compare:set", draft})
		},
		merge(into: AutomergeUrl) {
			close()
			props.send({type: "merge:start", into})
		},
		copy() {
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
				? `Delete “${props.ours.name}” and the drafts copied from it? This can't be undone.`
				: `Delete “${props.ours.name}”? This can't be undone.`
			if (window.confirm(warning)) props.send({type: "draft:delete", draft: props.ours.url})
		},
	}

	return (
		<>
			<button
				ref={token}
				type="button"
				class="projects__token"
				classList={{"projects__token--ours": props.comparing}}
				aria-haspopup="menu"
				title="Drafts"
				popovertarget={id}>
				<Show when={props.comparing}>
					<span class="projects__token-dot" aria-hidden="true" />
				</Show>
				<span class="projects__token-name">{props.ours.name}</span>
				<CaretIcon />
			</button>
			<div
				ref={menu}
				id={id}
				popover="auto"
				role="menu"
				class="projects__menu"
				onBeforeToggle={event => {
					if (event.newState === "open") below(token, menu)
				}}
				onToggle={event => {
					if (event.newState === "closed") preview(null)
				}}>
				<p class="projects__menu-heading">Drafts</p>
				<div onMouseEnter={closeSubmenus}>
					<For each={props.entries}>
						{entry => (
							<button
								type="button"
								role="menuitemradio"
								aria-checked={entry.url === props.ours.url}
								class="projects__menu-item"
								onClick={() => actions.checkout(entry.url)}>
								<span class="projects__menu-icon projects__menu-check">
									<Show when={entry.url === props.ours.url}>
										<CheckIcon />
									</Show>
								</span>
								<span class="projects__menu-name">{entry.name}</span>
								<Show when={copiedFrom(entry)}>
									{meta => <span class="projects__menu-meta">{meta()}</span>}
								</Show>
							</button>
						)}
					</For>
				</div>
				<hr />
				<Show when={props.entries.length > 1}>
					<SubmenuItem
						ref={el => (compareItem = el)}
						icon={<CompareIcon />}
						expanded={submenu() === "compare"}
						open={() => beside(compareItem, menu, compareMenu)}>
						Compare with
					</SubmenuItem>
				</Show>
				<Show when={parent()}>
					<SubmenuItem
						ref={el => (mergeItem = el)}
						icon={<MergeIcon />}
						expanded={submenu() === "merge"}
						open={() => beside(mergeItem, menu, mergeMenu)}>
						Merge into
					</SubmenuItem>
				</Show>
				<div onMouseEnter={closeSubmenus}>
					<button type="button" role="menuitem" class="projects__menu-item" onClick={actions.copy}>
						<span class="projects__menu-icon">
							<CopyIcon />
						</span>
						Copy
					</button>
					<button type="button" role="menuitem" class="projects__menu-item" onClick={actions.rename}>
						<span class="projects__menu-icon" />
						Rename
					</button>
					<Show when={parent()}>
						<button
							type="button"
							role="menuitem"
							class="projects__menu-item projects__menu-item--danger"
							onClick={actions.remove}>
							<span class="projects__menu-icon" />
							Delete draft
						</button>
					</Show>
				</div>

				<DraftSubmenu
					ref={el => (compareMenu = el)}
					id={compareId}
					label={`Compare ${props.ours.name} with`}
					parent={parent()}
					others={others()}
					checked={url => props.compared === url}
					copiedFrom={copiedFrom}
					toggled={toggled("compare")}
					preview={preview}
					pick={actions.compare}
				/>
				<DraftSubmenu
					ref={el => (mergeMenu = el)}
					id={mergeId}
					label={`Merge ${props.ours.name} into`}
					parent={parent()}
					others={mergeTargets()}
					suggest
					detail={props.difference}
					copiedFrom={copiedFrom}
					toggled={toggled("merge")}
					preview={preview}
					pick={actions.merge}
				/>
			</div>
		</>
	)
}

/**
 * While the checked-out draft's merge into another is looked over: what it
 * does, and the choice to merge, which hides the merged draft and checks the
 * other out, or not.
 */
function MergeBar(props: {
	from: DraftEntry
	into: DraftEntry
	changes: CompareChanges | undefined
	element: HTMLElement
}) {
	const [merging, setMerging] = createSignal(false)
	const ready = () => props.changes?.mode === "merge" && props.changes.status === "ready"
	const counts = () => {
		const found = props.changes
		if (!ready() || !found) return undefined
		const marks = Object.values(found.files)
		const count = (mark: Mark) => marks.filter(each => each === mark).length
		return {
			added: count("added"),
			removed: count("removed"),
			changed: count("changed") + count("both"),
			review: count("both"),
		}
	}
	const cancel = () => void request(props.element, {type: "merge:cancel"})
	const merge = async () => {
		setMerging(true)
		try {
			await request(props.element, {type: "merge:commit"})
		} finally {
			setMerging(false)
		}
	}

	return (
		<div class="projects__merge" role="group" aria-label="Merge">
			<span class="projects__merge-title">
				Merge
				<span class="projects__token">
					<span class="projects__token-dot" aria-hidden="true" />
					<span class="projects__token-name">{props.from.name}</span>
				</span>
				into
				<span class="projects__token projects__token--into">
					<span class="projects__token-dot" aria-hidden="true" />
					<span class="projects__token-name">{props.into.name}</span>
				</span>
			</span>
			<span class="projects__merge-summary">
				<Show when={counts()} fallback="Working out the merge…">
					{found => <MergeCounts {...found()} />}
				</Show>
			</span>
			<button type="button" class="projects__button" onClick={cancel}>
				Cancel
			</button>
			<button
				type="button"
				class="projects__button projects__button--primary"
				disabled={!ready() || merging()}
				onClick={merge}>
				Merge
			</button>
		</div>
	)
}

function MergeCounts(props: {added: number; removed: number; changed: number; review: number}) {
	const parts = () =>
		[
			{count: props.added, label: "added", kind: "added"},
			{count: props.removed, label: "removed", kind: "removed"},
			{count: props.changed, label: "changed", kind: "changed"},
			{count: props.review, label: "to review", kind: "review"},
		].filter(part => part.count > 0)
	return (
		<Show when={parts().length > 0} fallback="Nothing changes">
			<For each={parts()}>
				{(part, index) => (
					<>
						<Show when={index() > 0}> · </Show>
						<span class={`projects__merge-count--${part.kind}`}>
							{part.count} {part.label}
						</span>
					</>
				)}
			</For>
		</Show>
	)
}

function SubmenuItem(props: {
	ref(element: HTMLButtonElement): void
	icon: JSX.Element
	expanded: boolean
	open(): void
	children: JSX.Element
}) {
	return (
		<button
			ref={props.ref}
			type="button"
			role="menuitem"
			aria-haspopup="menu"
			aria-expanded={props.expanded}
			class="projects__menu-item"
			onMouseEnter={() => props.open()}
			onClick={() => props.open()}>
			<span class="projects__menu-icon">{props.icon}</span>
			<span class="projects__menu-name">{props.children}</span>
			<span class="projects__menu-chevron">
				<ChevronIcon />
			</span>
		</button>
	)
}

/**
 * Drafts to pick one from, the one this was copied from first: hovering one
 * previews comparing with it, and leaving the list stops previewing.
 */
function DraftSubmenu(props: {
	ref(element: HTMLDivElement): void
	id: string
	label: string
	parent: DraftEntry | undefined
	others: DraftEntry[]
	/** the parent stands out as the one to pick */
	suggest?: boolean
	checked?(draft: AutomergeUrl): boolean
	detail?(draft: AutomergeUrl): string | undefined
	copiedFrom(entry: DraftEntry): string | undefined
	toggled(open: boolean): void
	preview(draft: AutomergeUrl | null): void
	pick(draft: AutomergeUrl): void
}) {
	const item = (entry: DraftEntry, meta: string | undefined, suggested = false) => (
		<button
			type="button"
			role={props.checked ? "menuitemradio" : "menuitem"}
			aria-checked={props.checked?.(entry.url)}
			class="projects__menu-item projects__menu-item--draft"
			classList={{"projects__menu-item--suggested": suggested}}
			onMouseEnter={() => props.preview(entry.url)}
			onFocus={() => props.preview(entry.url)}
			onClick={() => props.pick(entry.url)}>
			<span class="projects__menu-line">
				<span class="projects__menu-name">{entry.name}</span>
				<Show when={meta}>
					<span class="projects__menu-meta">{meta}</span>
				</Show>
				<Show when={props.checked?.(entry.url)}>
					<span class="projects__menu-check">
						<CheckIcon />
					</span>
				</Show>
			</span>
			<Show when={props.detail?.(entry.url)}>
				{detail => <span class="projects__menu-detail">{detail()}</span>}
			</Show>
		</button>
	)

	return (
		<div
			ref={props.ref}
			id={props.id}
			popover="auto"
			role="menu"
			class="projects__menu"
			onMouseLeave={() => props.preview(null)}
			onToggle={event => {
				props.toggled(event.newState === "open")
				if (event.newState === "closed") props.preview(null)
			}}>
			<p class="projects__menu-label">{props.label}</p>
			<Show when={props.parent}>
				{parent => (
					<>
						{item(parent(), "copied from", props.suggest)}
						<Show when={props.others.length > 0}>
							<hr />
						</Show>
					</>
				)}
			</Show>
			<For each={props.others}>{entry => item(entry, props.copiedFrom(entry))}</For>
		</div>
	)
}

// Under `anchor`, lined up with its left edge.
function below(anchor: HTMLElement, menu: HTMLElement) {
	const box = anchor.getBoundingClientRect()
	menu.style.top = `${box.bottom + 4}px`
	menu.style.left = `${Math.max(8, box.left)}px`
}

// To the right of `menu`, level with `item`, or to its left where the window
// ends.
function beside(item: HTMLElement, menu: HTMLElement, submenu: HTMLElement) {
	if (submenu.matches(":popover-open")) return
	const row = item.getBoundingClientRect()
	const box = menu.getBoundingClientRect()
	submenu.style.top = `${row.top - 4}px`
	submenu.style.left = `${box.right + 4}px`
	submenu.showPopover()
	const width = submenu.getBoundingClientRect().width
	if (box.right + 4 + width > window.innerWidth - 8)
		submenu.style.left = `${Math.max(8, box.left - 4 - width)}px`
}

// ours and theirs, side by side
function CompareIcon() {
	return (
		<svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
			<circle cx="5" cy="5" r="4" fill="var(--projects-ours)" />
			<circle cx="17" cy="5" r="4" fill="var(--projects-theirs)" />
		</svg>
	)
}

// ours going into theirs
function MergeIcon() {
	return (
		<svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
			<circle cx="3.5" cy="5" r="3.5" fill="var(--projects-ours)" />
			<path
				d="M8 5h5m-2-2.5L13.5 5 11 7.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.4"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
			<circle cx="18.5" cy="5" r="3.5" fill="var(--projects-theirs)" />
		</svg>
	)
}

// lucide `copy`
function CopyIcon() {
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
			stroke-linejoin="round"
			aria-hidden="true">
			<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</svg>
	)
}

// lucide `chevron-right`
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
			<path d="m9 18 6-6-6-6" />
		</svg>
	)
}
