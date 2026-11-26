import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request, subscribe, type Selector} from "@inkandswitch/patchwork-providers"
import {createEffect, createSignal, createUniqueId, For, onCleanup, Show, type JSX} from "solid-js"
import type {WorkspaceCompare} from "./compare.ts"
import {ComparePicker, ModeControls} from "./compare-ui.tsx"
import {pointName, useHistory, useNow, type MemberNames} from "./history.tsx"
import {CaretIcon, CheckIcon} from "./open-with.tsx"
import type {SidePanels} from "./side-panels.ts"
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
 * The bar above the card, flat on the page: the sidebar's button, the
 * workspace's name, then the version unit (what's checked out, and the next
 * thing to do with it), then, at its end, the buttons that unfold the
 * history and the comments beside the card.
 */
export function WorkspaceHeader(props: {
	name: string
	overlays: OverlaysState
	comparison: Comparison
	/** inside the compare provider, where requests go from */
	element: HTMLElement
	/** the workspace list, shown or hidden from the bar's start */
	sidebar: SidebarToggle
	/** the history and the comments, beside the card */
	panels: SidePanels
	/** what the members are called, for points in the history */
	names: MemberNames
	/** the compare modes every panel shares */
	compare: WorkspaceCompare
	/** where a root shown on its own puts its own controls */
	actions?(element: HTMLElement): void
	/** where a root shown on its own puts its compare controls, beside the unit */
	compareControls?(element: HTMLElement): void
}) {
	const send = (selector: Selector) => request(props.element, selector)
	// The project's documents have loaded once its members are known (the
	// tree has been walked). Told once; switching drafts doesn't hide it again.
	const [loaded, setLoaded] = createSignal(false)
	createEffect(() => {
		if (loaded()) return
		const selector = {type: "overlay:members", overlay: props.overlays.checkedOut, at: props.overlays.at}
		onCleanup(subscribe(props.element, selector as Selector, () => setLoaded(true)))
	})

	return (
		<header class="projects__topbar">
			<SidebarButton sidebar={props.sidebar} />
			<h1 class="projects__workspace-title">{props.name}</h1>
			{/* the unit once the project is in: not a lone "Main" over an empty card */}
			<Show when={loaded()}>
				<VersionUnit
					overlays={props.overlays}
					comparison={props.comparison}
					element={props.element}
					names={props.names}
					send={send}
				/>
			</Show>
			{/* comparing: the mode, then its controls, beside the unit */}
			<div class="projects__header-compare">
				<Show when={props.comparison && props.compare.offered().length > 0}>
					<WorkspaceModes compare={props.compare} />
				</Show>
				<div ref={element => props.compareControls?.(element)} class="projects__header-actions" />
			</div>
			<div class="projects__header-end">
				<div ref={element => props.actions?.(element)} class="projects__header-actions" />
				<button
					type="button"
					class="projects__icon-button"
					aria-pressed={props.panels.history()}
					title={props.panels.history() ? "Hide history" : "Show history"}
					aria-label={props.panels.history() ? "Hide history" : "Show history"}
					onClick={() => props.panels.toggleHistory()}>
					<ClockIcon />
				</button>
				<button
					type="button"
					class="projects__icon-button"
					aria-pressed={props.panels.comments()}
					title={props.panels.comments() ? "Hide comments" : "Show comments"}
					aria-label={props.panels.comments() ? "Hide comments" : "Show comments"}
					onClick={() => props.panels.toggleComments()}>
					<CommentIcon />
				</button>
			</div>
		</header>
	)
}

/**
 * What's checked out and what to do next with it, read as one sentence:
 *
 *   - one draft: `draft ▾ │ Compare`
 *   - a point in its history: `draft ▾ │ point · read-only ×`
 *   - two points: `draft ▾ │ Ⓐ earlier → Ⓑ later ×`
 *   - two versions: `● ours ▾ ↔ ● theirs ▾ ×`
 *   - a merge: `● source ▾ → ● target ▾ │ Cancel  Merge ▾`
 */
function VersionUnit(props: {
	overlays: OverlaysState
	comparison: Comparison
	element: HTMLElement
	names: MemberNames
	send(selector: Selector): Promise<unknown>
}) {
	const [renaming, setRenaming] = createSignal(false)
	const ours = () => props.overlays.checkedOut
	const merge = () => mergeShown(props.comparison)
	const draft = () => props.overlays.drafts.find(entry => entry.url === ours())
	const name = (overlay: Overlay) => overlayName(props.overlays, overlay)
	const now = useNow()
	const history = useHistory(
		() => props.element,
		() => props.overlays.checkedOut
	)
	const point = (at: string | null) => pointName(history(), at, props.names(), now())
	const range = () =>
		historyShown(props.comparison) && props.comparison?.kind === "compare" ? props.comparison : undefined
	const pair = () =>
		props.comparison?.kind === "compare" && !historyShown(props.comparison) ? props.comparison : undefined
	// Back to the working copy, comparing nothing.
	const leaveHistory = async () => {
		if (props.comparison) await props.send({type: "compare:clear"})
		await props.send({type: "overlay:checkout", overlay: ours(), at: null})
	}

	return (
		<Show
			when={merge()}
			fallback={
				<div class="projects__unit" role="group" aria-label="Version">
					<Show
						when={!renaming() || !draft()}
						fallback={
							<NameInput
								class="projects__token-rename"
								value={draft()!.name}
								label="Draft name"
								commit={next => {
									setRenaming(false)
									void props.send({type: "draft:rename", draft: draft()!.url, name: next})
								}}
								cancel={() => setRenaming(false)}
							/>
						}>
						<OverlayMenu
							overlays={props.overlays}
							comparison={props.comparison}
							send={props.send}
							rename={() => setRenaming(true)}
						/>
					</Show>
					<Show when={pair()}>
						{compared => (
							<>
								<span class="projects__unit-between" aria-label="compared with">
									<BetweenIcon />
								</span>
								<VersionPicker
									label={`Compare ${name(ours())} with`}
									title="Compared with"
									dot="var(--compare-b)"
									current={compared().b}
									overlays={compareChoices(props.overlays, ours())}
									name={name}
									checked={overlay => overlay === compared().b}
									pick={overlay => void props.send({type: "compare:set", overlay})}
								/>
								<ClearButton title="Stop comparing" onClick={() => void props.send({type: "compare:clear"})} />
							</>
						)}
					</Show>
					<Show when={range()}>
						{current => (
							<>
								<span class="projects__unit-divider" aria-hidden="true" />
								<span class="projects__point" title="Two points in its history">
									<span class="projects__point-badge">A</span>
									<span class="projects__point-name">{point(current().bAt)}</span>
								</span>
								<span class="projects__unit-between" aria-label="to">
									<ArrowIcon />
								</span>
								<span class="projects__point">
									<span class="projects__point-badge">B</span>
									<span class="projects__point-name">{point(current().aAt)}</span>
								</span>
								<ClearButton title="Back to the working copy" onClick={() => void leaveHistory()} />
							</>
						)}
					</Show>
					<Show when={!props.comparison && props.overlays.at}>
						{at => (
							<>
								<span class="projects__unit-divider" aria-hidden="true" />
								<span class="projects__point" title="As it was then, read-only">
									<span class="projects__point-name">{point(at())}</span>
									<span class="projects__point-note">read-only</span>
								</span>
								<ClearButton title="Back to the working copy" onClick={() => void leaveHistory()} />
							</>
						)}
					</Show>
					<Show when={!props.comparison && !props.overlays.at}>
						<span class="projects__unit-divider" aria-hidden="true" />
						<VersionPicker
							label={`Compare ${name(ours())} with`}
							title="Compare with another version"
							overlays={compareChoices(props.overlays, ours())}
							name={name}
							pick={overlay => void props.send({type: "compare:set", overlay})}>
							Compare
						</VersionPicker>
					</Show>
				</div>
			}>
			{current => (
				<MergeUnit
					merge={current()}
					overlays={props.overlays}
					element={props.element}
					send={props.send}
				/>
			)}
		</Show>
	)
}

/**
 * A merge checked out, a preview or a saved merge draft: its source and its
 * target, each changed from its token, then cancelling it and merging it,
 * or saving it to merge later. Merging and cancelling check another overlay
 * out.
 */
function MergeUnit(props: {
	merge: MergeEntry
	overlays: OverlaysState
	/** where `merge:conflicts` is asked from */
	element: HTMLElement
	send(selector: Selector): Promise<unknown>
}) {
	const name = (overlay: Overlay) => overlayName(props.overlays, overlay)
	const versions = () => versionChoices(props.overlays)
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
		if (props.merge.published && !window.confirm("Close this merge draft? This can't be undone.")) return
		void run({type: "overlay:delete", overlay: props.merge.url})
	}
	// Another pair: the merge draft there is for it, or a new preview.
	const repair = (source: Overlay, target: Overlay) => {
		if (source === target) return
		if (source === props.merge.source && target === props.merge.target) return
		void run({type: "merge:create", source, target})
	}
	const menuId = createUniqueId()
	let caret!: HTMLButtonElement
	let menu!: HTMLDivElement

	return (
		<div class="projects__unit" role="group" aria-label="Merge">
			<VersionPicker
				label="Merge from"
				title="Merging"
				dot="var(--compare-b)"
				current={props.merge.source}
				overlays={versions().filter(overlay => overlay !== props.merge.target)}
				name={name}
				checked={overlay => overlay === props.merge.source}
				pick={overlay => repair(overlay, props.merge.target)}
			/>
			<span class="projects__unit-between" aria-label="into">
				<ArrowIcon />
			</span>
			<VersionPicker
				label="Merge into"
				title="Merging into"
				dot="var(--compare-a)"
				current={props.merge.target}
				overlays={versions().filter(overlay => overlay !== props.merge.source)}
				name={name}
				checked={overlay => overlay === props.merge.target}
				pick={overlay => repair(props.merge.source, overlay)}
			/>
			<span class="projects__unit-divider" aria-hidden="true" />
			<Show when={open() > 0}>
				<span class="projects__merge-conflicts" role="status">
					{open() === 1 ? "1 conflict" : `${open()} conflicts`}
				</span>
			</Show>
			<button type="button" class="projects__unit-action" disabled={busy()} onClick={cancel}>
				{props.merge.published ? "Close" : "Cancel"}
			</button>
			<div class="projects__merge-split">
				<button
					type="button"
					class="projects__merge-button"
					disabled={busy() || conflicts() === undefined || open() > 0}
					title={open() > 0 ? "Resolve the conflicts first" : undefined}
					onClick={() => void run({type: "merge:accept", merge: props.merge.url})}>
					Merge
				</button>
				<Show when={!props.merge.published}>
					<button
						ref={caret}
						type="button"
						class="projects__merge-caret"
						aria-haspopup="menu"
						aria-label="More ways to merge"
						disabled={busy()}
						popovertarget={menuId}>
						<CaretIcon />
					</button>
					<div
						ref={menu}
						id={menuId}
						popover="auto"
						role="menu"
						class="projects__menu"
						onBeforeToggle={event => {
							if (event.newState === "open") below(caret, menu, "end")
						}}>
						<button
							type="button"
							role="menuitem"
							class="projects__menu-item"
							onClick={() => {
								menu.hidePopover()
								void run({type: "merge:publish", merge: props.merge.url})
							}}>
							<span class="projects__menu-icon" />
							<span class="projects__menu-name">Save merge draft</span>
						</button>
					</div>
				</Show>
			</div>
		</div>
	)
}

/**
 * A token in the unit that opens a list of versions to pick one from: a
 * version's name (with its dot, while two are on screen) or, given
 * children, those instead.
 */
function VersionPicker(props: {
	label: string
	title: string
	/** the version's colour, while two are on screen */
	dot?: string
	current?: Overlay
	overlays: Overlay[]
	name(overlay: Overlay): string
	checked?(overlay: Overlay): boolean
	pick(overlay: Overlay): void
	children?: JSX.Element
}) {
	const id = createUniqueId()
	let token!: HTMLButtonElement
	let menu!: HTMLDivElement
	return (
		<>
			<button
				ref={token}
				type="button"
				class="projects__token"
				classList={{"projects__token--action": !!props.children}}
				aria-haspopup="menu"
				title={props.title}
				disabled={props.overlays.length === 0}
				popovertarget={id}>
				<Show when={props.dot}>
					{color => <span class="projects__token-dot" style={{background: color()}} aria-hidden="true" />}
				</Show>
				<Show when={props.children} fallback={<span class="projects__token-name">{props.name(props.current ?? null)}</span>}>
					{props.children}
				</Show>
				<Show when={!props.children}>
					<CaretIcon />
				</Show>
			</button>
			<OverlaySubmenu
				ref={element => (menu = element)}
				id={id}
				label={props.label}
				overlays={props.overlays}
				name={props.name}
				checked={props.checked}
				anchor={() => token}
				toggled={() => {}}
				pick={overlay => {
					menu.hidePopover()
					props.pick(overlay)
				}}
			/>
		</>
	)
}

function ClearButton(props: {title: string; onClick(): void}) {
	return (
		<button
			type="button"
			class="projects__token-clear"
			title={props.title}
			aria-label={props.title}
			onClick={() => props.onClick()}>
			<CloseIcon />
		</button>
	)
}

/** Main and the drafts, each beneath the one it was copied from. */
function versionChoices(overlays: OverlaysState): Overlay[] {
	return [null, ...inTreeOrder(overlays.drafts).map(entry => entry.url)]
}

/** What `ours` can be compared with: the other versions, and the saved merge drafts. */
function compareChoices(overlays: OverlaysState, ours: Overlay): Overlay[] {
	const saved = overlays.merges.filter(entry => entry.published).map(entry => entry.url)
	return [...versionChoices(overlays), ...saved].filter(overlay => overlay !== ours)
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
 * The checked-out overlay's token, opening the drafts and saved merge
 * drafts to check out another, and what to do with this one: compare it with another
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
	const savedMerges = () => props.overlays.merges.filter(entry => entry.published)
	const compareWith = () =>
		[...versions(), ...savedMerges().map(entry => entry.url)].filter(overlay => overlay !== ours())
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
			// Opens a preview, or the merge draft there is for the pair.
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
				<Show when={savedMerges().length > 0}>
					<p class="projects__menu-heading">Merge drafts</p>
					<div onMouseEnter={closeSubmenus}>
						<For each={savedMerges()}>{entry => item(entry.url)}</For>
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
	/** opened from this, under it; otherwise placed by whatever opens it */
	anchor?(): HTMLElement
	toggled(open: boolean): void
	pick(overlay: Overlay): void
}) {
	let menu!: HTMLDivElement
	return (
		<div
			ref={element => {
				menu = element
				props.ref(element)
			}}
			id={props.id}
			popover="auto"
			role="menu"
			class="projects__menu"
			onBeforeToggle={event => {
				const anchor = props.anchor?.()
				if (event.newState === "open" && anchor) below(anchor, menu)
			}}
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

// Under `anchor`, lined up with its left edge, or its right one.
function below(anchor: HTMLElement, menu: HTMLElement, align: "start" | "end" = "start") {
	const box = anchor.getBoundingClientRect()
	menu.style.top = `${box.bottom + 4}px`
	// Not shown yet, so not measured: placed by the edge it lines up with.
	if (align === "start") {
		menu.style.left = `${Math.max(8, box.left)}px`
		menu.style.right = "auto"
		return
	}
	menu.style.left = "auto"
	menu.style.right = `${Math.max(8, document.documentElement.clientWidth - box.right)}px`
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

// lucide `clock`
function ClockIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="10" />
			<path d="M12 6v6l4 2" />
		</svg>
	)
}

// lucide `message-square`
function CommentIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
		</svg>
	)
}

// lucide `arrow-right`
function ArrowIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M5 12h14" />
			<path d="m12 5 7 7-7 7" />
		</svg>
	)
}

// lucide `move-horizontal`: two versions side by side, neither before the other
function BetweenIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="m18 8 4 4-4 4" />
			<path d="M2 12h20" />
			<path d="m6 8-4 4 4 4" />
		</svg>
	)
}

// lucide `x`
function CloseIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	)
}
