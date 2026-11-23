import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request, type Selector} from "@inkandswitch/patchwork-providers"
import {createSignal, createUniqueId, For, Show, type JSX} from "solid-js"
import type {WorkspaceCompare} from "./compare.ts"
import {ComparePicker, ModeControls} from "./compare-ui.tsx"
import {CommentsButton, type CommentsToggle} from "./comments.tsx"
import {CaretIcon, CheckIcon} from "./open-with.tsx"
import {
	mergeOf,
	overlayName,
	type Comparison,
	type DraftEntry,
	type MergeEntry,
	type Overlay,
	type OverlaysState,
} from "./types.ts"
import {NameInput, SidebarButton, type SidebarToggle} from "./workspaces.tsx"

/**
 * The workspace card's header: its name, then the checked-out overlay as a
 * token opening everything to do with drafts and merges, and what it's
 * compared with beside it. A merge checked out shows as the merge, to accept
 * or drop.
 */
export function WorkspaceHeader(props: {
	name: string
	overlays: OverlaysState
	comparison: Comparison
	/** inside the compare provider, where requests go from */
	element: HTMLElement
	/** the sidebar, shown or hidden from the card header */
	sidebar: SidebarToggle
	/** the comments sidebar, shown or hidden from the header's end */
	comments: CommentsToggle
	/** the compare modes every panel shares */
	compare: WorkspaceCompare
	/** where a root shown on its own puts its own controls */
	actions?(element: HTMLElement): void
	/** where a root shown on its own puts its compare controls, beside the drafts */
	compareControls?(element: HTMLElement): void
}) {
	const [renaming, setRenaming] = createSignal(false)
	const send = (selector: Selector) => request(props.element, selector)
	const ours = () => props.overlays.checkedOut
	const merge = () => mergeOf(props.overlays, ours())
	const draft = () => props.overlays.drafts.find(entry => entry.url === ours())
	const name = (overlay: Overlay) => overlayName(props.overlays, overlay)

	return (
		<header class="projects__card-header">
			<SidebarButton sidebar={props.sidebar} />
			<h1 class="projects__workspace-title">{props.name}</h1>
			<Show when={merge()}>
				{current => <MergeBar merge={current()} name={name} send={send} />}
			</Show>
			<Show when={!merge()}>
				<div class="projects__tokens">
					<Show
						when={!renaming() || !draft()}
						fallback={
							<NameInput
								class="projects__token-rename"
								value={draft()!.name}
								label="Draft name"
								commit={next => {
									setRenaming(false)
									void send({type: "draft:rename", draft: draft()!.url, name: next})
								}}
								cancel={() => setRenaming(false)}
							/>
						}>
						<OverlayMenu
							overlays={props.overlays}
							comparison={props.comparison}
							send={send}
							rename={() => setRenaming(true)}
						/>
					</Show>
					<Show when={props.comparison}>
						{compared => (
							<>
								<span class="projects__tokens-between" aria-hidden="true">
									↔
								</span>
								<span class="projects__token projects__token--theirs" title="Compared with">
									<span class="projects__token-dot" aria-hidden="true" />
									<span class="projects__token-name">{name(compared().b)}</span>
									<button
										type="button"
										class="projects__token-clear"
										title="Stop comparing"
										aria-label="Stop comparing"
										onClick={() => void send({type: "compare:clear"})}>
										×
									</button>
								</span>
							</>
						)}
					</Show>
				</div>
			</Show>
			{/* comparing: the mode, then its controls, beside the drafts */}
			<div class="projects__header-compare">
				<Show when={props.comparison && props.compare.offered().length > 0}>
					<WorkspaceModes compare={props.compare} />
				</Show>
				<div
					ref={element => props.compareControls?.(element)}
					class="projects__header-actions"
				/>
			</div>
			<div class="projects__header-end">
				<div ref={element => props.actions?.(element)} class="projects__header-actions" />
				<Show when={merge()}>
					{current => <AcceptButton merge={current()} send={send} />}
				</Show>
				<CommentsButton comments={props.comments} />
			</div>
		</header>
	)
}

/**
 * The compare mode for every panel at once, at the header's end: picking
 * one puts each panel that takes it in it. The controls of modes whose
 * options are the workspace's sit beside it, while a panel's in one.
 */
function WorkspaceModes(props: {compare: WorkspaceCompare}) {
	const current = () => {
		const offered = props.compare.offered()
		const picked = props.compare.picked()?.mode
		const inUse = props.compare.inUse()
		return (
			offered.find(mode => mode.id === picked) ?? (inUse.length === 1 ? inUse[0] : undefined)
		)
	}
	const shared = () =>
		props.compare
			.inUse()
			.filter(mode => mode.module.scope === "workspace" && mode.module.controls)
	return (
		<div class="projects__workspace-modes">
			<ComparePicker
				modes={props.compare.offered()}
				current={current()}
				title="Compare every panel"
				pick={props.compare.pick}
			/>
			<For each={shared()}>
				{mode => (
					<ModeControls
						mode={mode}
						options={props.compare.options(mode)}
						versions={props.compare.versions()}
					/>
				)}
			</For>
		</div>
	)
}

/**
 * The checked-out overlay's token, opening the drafts and merges to check
 * out another, and what to do with this one: compare it with another
 * version or merge it into one, copy it, rename it, delete it.
 */
function OverlayMenu(props: {
	overlays: OverlaysState
	comparison: Comparison
	send(selector: Selector): Promise<unknown>
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
	const ours = () => props.overlays.checkedOut
	const name = (overlay: Overlay) => overlayName(props.overlays, overlay)
	const draft = () => props.overlays.drafts.find(entry => entry.url === ours())
	const drafts = () => inTreeOrder(props.overlays.drafts)
	const copiedFrom = (entry: DraftEntry) => `copied from ${name(entry.parent)}`
	// What a draft would merge into first: the one it was copied from.
	const parent = (): Overlay | undefined => draft()?.parent
	const versions = (): Overlay[] => [null, ...drafts().map(entry => entry.url)]
	const compareWith = () =>
		[...versions(), ...props.overlays.merges.map(entry => entry.url)].filter(
			overlay => overlay !== ours()
		)
	const mergeInto = () => {
		const others = versions().filter(overlay => overlay !== ours())
		const first = parent()
		return first === undefined ? others : [first, ...others.filter(overlay => overlay !== first)]
	}
	const hasCopies = () => props.overlays.drafts.some(entry => entry.parent === ours())
	const [submenu, setSubmenu] = createSignal<"compare" | "merge">()
	const toggled = (which: "compare" | "merge") => (open: boolean) =>
		setSubmenu(current => (open ? which : current === which ? undefined : current))
	const close = () => menu.hidePopover()
	const closeSubmenus = () => {
		compareMenu.hidePopover()
		mergeMenu.hidePopover()
	}

	const actions = {
		checkout(overlay: Overlay) {
			close()
			if (overlay === ours()) return
			void props.send({type: "overlay:checkout", overlay}).then(done => {
				// A merge is looked over against its target.
				const merge = mergeOf(props.overlays, overlay)
				if (done && merge) void props.send({type: "compare:set", overlay: merge.target})
			})
		},
		compare(overlay: Overlay) {
			close()
			void props.send({type: "compare:set", overlay})
		},
		merge(target: Overlay) {
			close()
			void props.send({type: "merge:create", source: ours(), target}).then(merge => {
				if (merge) void props.send({type: "compare:set", overlay: target})
			})
		},
		copy() {
			close()
			void props.send({type: "draft:create", parent: ours()})
		},
		rename() {
			close()
			props.rename()
		},
		remove() {
			const current = draft()
			close()
			if (!current) return
			const warning = hasCopies()
				? `Delete “${current.name}”? The drafts copied from it stay. This can't be undone.`
				: `Delete “${current.name}”? This can't be undone.`
			if (window.confirm(warning)) void props.send({type: "overlay:delete", overlay: current.url})
		},
	}

	const item = (overlay: Overlay, meta?: string) => (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={overlay === ours()}
			class="projects__menu-item"
			onClick={() => actions.checkout(overlay)}>
			<span class="projects__menu-icon projects__menu-check">
				<Show when={overlay === ours()}>
					<CheckIcon />
				</Show>
			</span>
			<span class="projects__menu-name">{name(overlay)}</span>
			<Show when={meta}>
				<span class="projects__menu-meta">{meta}</span>
			</Show>
		</button>
	)

	return (
		<>
			<button
				ref={token}
				type="button"
				class="projects__token"
				classList={{"projects__token--ours": !!props.comparison}}
				aria-haspopup="menu"
				title="Drafts"
				popovertarget={id}>
				<Show when={props.comparison}>
					<span class="projects__token-dot" aria-hidden="true" />
				</Show>
				<span class="projects__token-name">{name(ours())}</span>
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
				}}>
				<p class="projects__menu-heading">Drafts</p>
				<div onMouseEnter={closeSubmenus}>
					{item(null)}
					<For each={drafts()}>{entry => item(entry.url, copiedFrom(entry))}</For>
				</div>
				<Show when={props.overlays.merges.length > 0}>
					<p class="projects__menu-heading">Merges</p>
					<div onMouseEnter={closeSubmenus}>
						<For each={props.overlays.merges}>{entry => item(entry.url)}</For>
					</div>
				</Show>
				<hr />
				<Show when={compareWith().length > 0}>
					<SubmenuItem
						ref={el => (compareItem = el)}
						expanded={submenu() === "compare"}
						open={() => beside(compareItem, menu, compareMenu)}>
						Compare with
					</SubmenuItem>
				</Show>
				<Show when={mergeInto().length > 0}>
					<SubmenuItem
						ref={el => (mergeItem = el)}
						expanded={submenu() === "merge"}
						open={() => beside(mergeItem, menu, mergeMenu)}>
						Merge into
					</SubmenuItem>
				</Show>
				<div onMouseEnter={closeSubmenus}>
					<button type="button" role="menuitem" class="projects__menu-item" onClick={actions.copy}>
						<span class="projects__menu-icon" />
						Create draft
					</button>
					<Show when={draft()}>
						<button type="button" role="menuitem" class="projects__menu-item" onClick={actions.rename}>
							<span class="projects__menu-icon" />
							Rename
						</button>
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

				<OverlaySubmenu
					ref={el => (compareMenu = el)}
					id={compareId}
					label={`Compare ${name(ours())} with`}
					overlays={compareWith()}
					name={name}
					checked={overlay => props.comparison?.b === overlay}
					toggled={toggled("compare")}
					pick={actions.compare}
				/>
				<OverlaySubmenu
					ref={el => (mergeMenu = el)}
					id={mergeId}
					label={`Merge ${name(ours())} into`}
					overlays={mergeInto()}
					name={name}
					suggested={parent()}
					toggled={toggled("merge")}
					pick={actions.merge}
				/>
			</div>
		</>
	)
}

/**
 * While a merge is checked out: its source and its target, closing to drop
 * the merge. Accepting it is at the header's end.
 */
function MergeBar(props: {
	merge: MergeEntry
	name(overlay: Overlay): string
	send(selector: Selector): Promise<unknown>
}) {
	const drop = () => void props.send({type: "overlay:delete", overlay: props.merge.url})
	return (
		<div class="projects__merge" role="group" aria-label="Merge">
			<span class="projects__tokens">
				<span class="projects__token" title="Merging">
					<span class="projects__token-dot" aria-hidden="true" />
					<span class="projects__token-name">{props.name(props.merge.source)}</span>
				</span>
				<span class="projects__tokens-between" aria-label="into">
					→
				</span>
				<span class="projects__token projects__token--theirs" title="Merging into">
					<span class="projects__token-dot" aria-hidden="true" />
					<span class="projects__token-name">{props.name(props.merge.target)}</span>
					<button
						type="button"
						class="projects__token-clear"
						title="Drop the merge"
						aria-label="Drop the merge"
						onClick={drop}>
						×
					</button>
				</span>
			</span>
		</div>
	)
}

/** Accepts the checked-out merge, which checks its target out. */
function AcceptButton(props: {merge: MergeEntry; send(selector: Selector): Promise<unknown>}) {
	const [merging, setMerging] = createSignal(false)
	const accept = async () => {
		setMerging(true)
		try {
			await props.send({type: "merge:accept", merge: props.merge.url})
		} finally {
			setMerging(false)
		}
	}
	return (
		<button
			type="button"
			class="projects__button projects__merge-button"
			disabled={merging()}
			onClick={accept}>
			Merge
		</button>
	)
}

/** Versions to pick one from, the suggested one first. */
function OverlaySubmenu(props: {
	ref(element: HTMLDivElement): void
	id: string
	label: string
	overlays: Overlay[]
	name(overlay: Overlay): string
	/** stands out as the one to pick */
	suggested?: Overlay
	checked?(overlay: Overlay): boolean
	toggled(open: boolean): void
	pick(overlay: Overlay): void
}) {
	return (
		<div
			ref={props.ref}
			id={props.id}
			popover="auto"
			role="menu"
			class="projects__menu"
			onToggle={event => props.toggled(event.newState === "open")}>
			<p class="projects__menu-label">{props.label}</p>
			<For each={props.overlays}>
				{overlay => (
					<button
						type="button"
						role={props.checked ? "menuitemradio" : "menuitem"}
						aria-checked={props.checked?.(overlay)}
						class="projects__menu-item projects__menu-item--draft"
						classList={{"projects__menu-item--suggested": overlay === props.suggested}}
						onClick={() => props.pick(overlay)}>
						<span class="projects__menu-line">
							<span class="projects__menu-name">{props.name(overlay)}</span>
							<Show when={overlay === props.suggested}>
								<span class="projects__menu-meta">copied from</span>
							</Show>
							<Show when={props.checked?.(overlay)}>
								<span class="projects__menu-check">
									<CheckIcon />
								</span>
							</Show>
						</span>
					</button>
				)}
			</For>
		</div>
	)
}

/** Drafts with each one beneath the one it was copied from. */
function inTreeOrder(drafts: DraftEntry[]): DraftEntry[] {
	const children = (parent: AutomergeUrl | null) => drafts.filter(entry => entry.parent === parent)
	const out: DraftEntry[] = []
	const visit = (parent: AutomergeUrl | null) => {
		for (const entry of children(parent)) {
			out.push(entry)
			visit(entry.url)
		}
	}
	visit(null)
	return out
}

function SubmenuItem(props: {
	ref(element: HTMLButtonElement): void
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
			<span class="projects__menu-icon" />
			<span class="projects__menu-name">{props.children}</span>
			<span class="projects__menu-chevron">
				<ChevronIcon />
			</span>
		</button>
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
