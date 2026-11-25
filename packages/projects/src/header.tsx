import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request, subscribe, type Selector} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, createUniqueId, For, onCleanup, Show, type JSX} from "solid-js"
import type {WorkspaceCompare} from "./compare.ts"
import {ComparePicker, ModeControls} from "./compare-ui.tsx"
import {CommentsButton, type CommentsToggle} from "./comments.tsx"
import {ago, pointName, useHistory, useNow} from "./history.tsx"
import {CaretIcon, CheckIcon} from "./open-with.tsx"
import {
	historyShown,
	mergeShown,
	openConflicts,
	overlayName,
	type Comparison,
	type MergeConflicts,
	type DraftEntry,
	type MergeEntry,
	type Overlay,
	type OverlaysState,
} from "./types.ts"
import {NameInput, SidebarButton, type SidebarToggle} from "./workspaces.tsx"

/**
 * The workspace card's header: its name, then the checked-out overlay as a
 * token opening everything to do with drafts and pull requests, and what
 * it's compared with beside it, or the point in its history it's seen at,
 * or the two points compared. A merge checked out, a preview or a pull
 * request, shows as the merge: to merge, publish, or cancel.
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
	const merge = () => mergeShown(props.comparison)
	const draft = () => props.overlays.drafts.find(entry => entry.url === ours())
	const name = (overlay: Overlay) => overlayName(props.overlays, overlay)
	const now = useNow()
	const history = useHistory(
		() => props.element,
		() => props.overlays.checkedOut
	)
	const point = (at: string | null) => pointName(history(), at, now())
	// The project's documents have loaded once its members are known (the
	// tree has been walked). Told once; switching drafts doesn't hide it again.
	const [loaded, setLoaded] = createSignal(false)
	createEffect(() => {
		if (loaded()) return
		const selector = {type: "overlay:members", overlay: props.overlays.checkedOut, at: props.overlays.at}
		onCleanup(subscribe(props.element, selector as Selector, () => setLoaded(true)))
	})
	const range = () =>
		historyShown(props.comparison) && props.comparison?.kind === "compare" ? props.comparison : undefined
	// Back to the working copy, comparing nothing.
	const leaveHistory = async () => {
		if (props.comparison) await send({type: "compare:clear"})
		await send({type: "overlay:checkout", overlay: ours(), at: null})
	}

	return (
		<header class="projects__card-header">
			<SidebarButton sidebar={props.sidebar} />
			<h1 class="projects__workspace-title">{props.name}</h1>
			<Show when={merge()}>
				{current => <MergeBar merge={current()} name={name} element={props.element} />}
			</Show>
			{/* the drafts once the project is in: not a lone "Main" over an empty card */}
			<Show when={!merge() && loaded()}>
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
					<Show when={range()}>
						{current => (
							<span class="projects__token projects__token--range" title="Two points in its history">
								<span class="projects__point">
									<span class="projects__point-badge">A</span>
									{point(current().bAt)}
								</span>
								<span class="projects__tokens-between" aria-label="to">
									→
								</span>
								<span class="projects__point">
									<span class="projects__point-badge">B</span>
									{point(current().aAt)}
								</span>
								<button
									type="button"
									class="projects__token-clear"
									title="Back to the working copy"
									aria-label="Back to the working copy"
									onClick={() => void leaveHistory()}>
									×
								</button>
							</span>
						)}
					</Show>
					<Show when={!props.comparison && props.overlays.at}>
						{at => (
							<span class="projects__token projects__token--range" title="As it was then, read-only">
								<span class="projects__point">{point(at())}</span>
								<span class="projects__point-note">read-only</span>
								<button
									type="button"
									class="projects__token-clear"
									title="Back to the working copy"
									aria-label="Back to the working copy"
									onClick={() => void leaveHistory()}>
									×
								</button>
							</span>
						)}
					</Show>
					<Show when={props.comparison && !range() ? props.comparison : undefined}>
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
					{current => <MergeActions merge={current()} element={props.element} send={send} />}
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
	const twoVersions = () => !!props.comparison && !historyShown(props.comparison)
	const copiedFrom = (entry: DraftEntry) => `copied from ${name(entry.parent)}`
	// What a draft would merge into first: the one it was copied from.
	const parent = (): Overlay | undefined => draft()?.parent
	const versions = (): Overlay[] => [null, ...drafts().map(entry => entry.url)]
	const pullRequests = () => props.overlays.merges.filter(entry => entry.published)
	const compareWith = () =>
		[...versions(), ...pullRequests().map(entry => entry.url)].filter(overlay => overlay !== ours())
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
			// A merge is compared with its target by the compare provider.
			void props.send({type: "overlay:checkout", overlay})
		},
		compare(overlay: Overlay) {
			close()
			void props.send({type: "compare:set", overlay})
		},
		merge(target: Overlay) {
			close()
			// Opens a preview, or the pull request there is for the pair.
			void props.send({type: "merge:create", source: ours(), target})
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
				classList={{"projects__token--ours": twoVersions()}}
				aria-haspopup="menu"
				title="Drafts"
				popovertarget={id}>
				{/* coloured only beside another version, not two points in its own history */}
				<Show when={twoVersions()}>
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
				<Show when={pullRequests().length > 0}>
					<p class="projects__menu-heading">Pull requests</p>
					<div onMouseEnter={closeSubmenus}>
						<For each={pullRequests()}>{entry => item(entry.url)}</For>
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
 * While a merge is checked out: whether it's a preview or a pull request,
 * and its source and target: what of the source's history it merges, from
 * where the two parted to its latest, and the target's latest it lands on.
 * What to do with it is at the header's end.
 */
function MergeBar(props: {
	merge: MergeEntry
	name(overlay: Overlay): string
	/** where `overlay:history` is asked from */
	element: HTMLElement
}) {
	const now = useNow()
	const source = useHistory(
		() => props.element,
		() => props.merge.source
	)
	const target = useHistory(
		() => props.element,
		() => props.merge.target
	)
	const span = () => {
		const ours = source()
		const theirs = target()
		if (!ours || !theirs) return undefined
		const inTarget = new Set(theirs.map(entry => entry.id))
		const inSource = new Set(ours.map(entry => entry.id))
		const from = ours.find(entry => inTarget.has(entry.id))
		const to = ours.find(entry => !inTarget.has(entry.id))
		const into = theirs.find(entry => !inSource.has(entry.id)) ?? theirs[0]
		return {
			range: to ? `${from ? ago(from.time, now()) : "From the start"} → ${ago(to.time, now())}` : undefined,
			into: into ? ago(into.time, now()) : undefined,
		}
	}
	return (
		<div class="projects__merge" role="group" aria-label="Merge">
			<span class="projects__merge-kind">{props.merge.published ? "Pull request" : "Preview"}</span>
			<span class="projects__tokens">
				<span class="projects__token" title="Merging">
					<span class="projects__token-name">{props.name(props.merge.source)}</span>
					<Show when={span()?.range}>
						{range => <span class="projects__token-meta">{range()}</span>}
					</Show>
				</span>
				<span class="projects__tokens-between" aria-label="into">
					→
				</span>
				<span class="projects__token" title="Merging into">
					<span class="projects__token-name">{props.name(props.merge.target)}</span>
					<Show when={span()?.into}>
						{into => <span class="projects__token-meta">{into()}</span>}
					</Show>
				</span>
			</span>
		</div>
	)
}

/**
 * What to do with the checked-out merge: merge it (once no conflict is
 * open), publish a preview as a pull request, or cancel it (close, for a
 * pull request). Merging and cancelling check another overlay out.
 */
function MergeActions(props: {
	merge: MergeEntry
	/** where `merge:conflicts` is asked from */
	element: HTMLElement
	send(selector: Selector): Promise<unknown>
}) {
	const [busy, setBusy] = createSignal(false)
	const [conflicts, setConflicts] = createSignal<MergeConflicts>()
	createEffect(() => {
		const url = props.merge.url
		setConflicts(undefined)
		onCleanup(
			subscribe(props.element, {type: "merge:conflicts", merge: url}, value =>
				setConflicts(value as unknown as MergeConflicts)
			)
		)
	})
	const open = () => openConflicts(conflicts())
	const run = async (selector: Selector) => {
		setBusy(true)
		try {
			await props.send(selector)
		} finally {
			setBusy(false)
		}
	}
	const cancel = () => {
		if (props.merge.published && !window.confirm("Close this pull request? This can't be undone.")) return
		void run({type: "overlay:delete", overlay: props.merge.url})
	}
	return (
		<div class="projects__merge-actions">
			<Show when={open() > 0}>
				<span class="projects__merge-conflicts" role="status">
					{open() === 1 ? "1 conflict" : `${open()} conflicts`}
				</span>
			</Show>
			<button type="button" class="projects__button" disabled={busy()} onClick={cancel}>
				{props.merge.published ? "Close" : "Cancel"}
			</button>
			<Show when={!props.merge.published}>
				<button
					type="button"
					class="projects__button"
					disabled={busy()}
					onClick={() => void run({type: "merge:publish", merge: props.merge.url})}>
					Create pull request
				</button>
			</Show>
			<button
				type="button"
				class="projects__button projects__merge-button"
				disabled={busy() || conflicts() === undefined || open() > 0}
				title={open() > 0 ? "Resolve the conflicts first" : undefined}
				onClick={() => void run({type: "merge:accept", merge: props.merge.url})}>
				Merge
			</button>
		</div>
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
