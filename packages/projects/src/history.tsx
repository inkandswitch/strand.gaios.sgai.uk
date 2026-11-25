import {request, subscribe, type Selector} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor} from "solid-js"
import {
	historyShown,
	overlayName,
	type At,
	type Comparison,
	type HistoryEntry,
	type Overlay,
	type OverlaysState,
} from "./types.ts"

const OPEN_KEY = "gaios-projects:history"

// A burst still going: its last change is more recent than this, so it's
// the working copy rather than an entry of its own yet.
const OPEN_ENTRY_SECONDS = 10 * 60

const ROW = 46
const LANE_X = [20, 150] as const
const TEXT_X = [38, 168] as const

/** `overlay`'s history, the newest entry first, while it's asked for. */
export function useHistory(
	element: Accessor<HTMLElement | undefined>,
	overlay: Accessor<Overlay | undefined>
): Accessor<HistoryEntry[] | undefined> {
	const [entries, setEntries] = createSignal<HistoryEntry[]>()
	createEffect(() => {
		const at = element()
		const which = overlay()
		setEntries(undefined)
		if (!at || which === undefined) return
		onCleanup(
			subscribe<HistoryEntry[]>(at, {type: "overlay:history", overlay: which} as Selector, value =>
				setEntries(value)
			)
		)
	})
	return entries
}

/** Seconds since the epoch, ticking every half minute, for "how long ago". */
export function useNow(): Accessor<number> {
	const [now, setNow] = createSignal(Date.now() / 1000)
	const timer = setInterval(() => setNow(Date.now() / 1000), 30_000)
	onCleanup(() => clearInterval(timer))
	return now
}

/** How long ago `time` (Unix seconds) was, as an entry's title. */
export function ago(time: number, now: number): string {
	const seconds = Math.max(0, now - time)
	if (seconds < 60) return "Just now"
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`
	const days = Math.floor(hours / 24)
	if (days < 30) return days === 1 ? "Yesterday" : `${days} days ago`
	const months = Math.floor(days / 30)
	if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`
	const years = Math.floor(days / 365)
	return years <= 1 ? "1 year ago" : `${years} years ago`
}

// When, on the clock or the calendar.
function when(time: number, now: number): string {
	const date = new Date(time * 1000)
	const today = new Date(now * 1000).toDateString() === date.toDateString()
	return today
		? date.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})
		: date.toLocaleDateString(undefined, {month: "short", day: "numeric"})
}

/** Whether `entries`' newest is still going, and so the working copy. */
export function openEntry(entries: HistoryEntry[] | undefined, now: number): HistoryEntry | undefined {
	const newest = entries?.[0]
	return newest && now - newest.time < OPEN_ENTRY_SECONDS ? newest : undefined
}

/** What a point in history is called: how long ago, or the working copy. */
export function pointName(entries: HistoryEntry[] | undefined, at: At, now: number): string {
	if (at === null) return "Working copy"
	const entry = entries?.find(each => each.id === at)
	return entry ? ago(entry.time, now) : "Earlier"
}

type Lane = 0 | 1

type Row =
	| {kind: "working"; lane: Lane; label: string; meta: string}
	| {kind: "entry"; entry: HistoryEntry; lane: Lane}
	// What two versions share, from before they parted, folded into one row.
	| {kind: "parted"; lane: 0; count: number}

const keyOf = (row: Row) =>
	row.kind === "working" ? `working-${row.lane}` : row.kind === "parted" ? "parted" : row.entry.id

type Badge = {label: string; tone: "a" | "b" | "neutral"}

/**
 * The card's history, beside everything below the header: a rail of dots,
 * and, unfolded, the entries. One lane for the checked-out overlay, with its
 * working copy at the top: clicking an entry views it, read-only, and
 * shift-clicking another compares the two. While two overlays are compared
 * or merged, a lane for each down to where they parted, and then the
 * history they share.
 */
export function HistoryPanel(props: {
	element: HTMLElement
	overlays: OverlaysState
	comparison: Comparison
}) {
	const [open, setOpen] = createSignal(readOpen())
	const toggle = () => {
		const next = !open()
		setOpen(next)
		try {
			localStorage.setItem(OPEN_KEY, next ? "open" : "closed")
		} catch {
			// remembered for this page only
		}
	}
	const now = useNow()
	const send = (selector: Record<string, unknown>) => request(props.element, selector as Selector)
	const element = () => props.element

	const merge = () => (props.comparison?.kind === "merge" ? props.comparison : undefined)
	const pair = () =>
		props.comparison?.kind === "compare" && !historyShown(props.comparison) ? props.comparison : undefined
	// The lanes: one overlay, or two side by side (B, then A; a merge's target, then its source).
	const left = () => {
		const merging = merge()
		if (merging) return merging.target
		const compared = pair()
		return compared ? compared.b : props.overlays.checkedOut
	}
	const right = () => {
		const merging = merge()
		if (merging) return merging.source
		const compared = pair()
		return compared ? compared.a : undefined
	}
	const leftEntries = useHistory(element, left)
	const rightEntries = useHistory(element, right)

	// Two points in one history: the later checked out, the earlier compared.
	const range = () =>
		historyShown(props.comparison) && props.comparison?.kind === "compare"
			? {later: props.comparison.aAt, earlier: props.comparison.bAt}
			: undefined

	const rows = createMemo<Row[]>(() => {
		const ours = leftEntries() ?? []
		if (right() === undefined) {
			const going = openEntry(ours, now())
			return [
				{kind: "working", lane: 0, label: "Working copy", meta: "now"},
				...ours.filter(entry => entry !== going).map(entry => ({kind: "entry", entry, lane: 0}) as Row),
			]
		}
		// Two lanes: what each has of its own since they parted, newest first,
		// then what they share, folded away.
		const theirs = rightEntries() ?? []
		const inLeft = new Set(ours.map(entry => entry.id))
		const inRight = new Set(theirs.map(entry => entry.id))
		const merging = !!merge()
		const leftOwn = ours.filter(entry => !inRight.has(entry.id))
		const rightOwn = theirs.filter(entry => !inLeft.has(entry.id))
		// Comparing, each lane's working copy heads it, and a burst still
		// going is that working copy.
		const settled = (own: HistoryEntry[]) => {
			const going = merging ? undefined : openEntry(own, now())
			return own.filter(entry => entry !== going)
		}
		const own: Row[] = [
			...settled(leftOwn).map(entry => ({kind: "entry", entry, lane: 0}) as Row),
			...settled(rightOwn).map(entry => ({kind: "entry", entry, lane: 1}) as Row),
		].sort((a, b) => (b as {entry: HistoryEntry}).entry.time - (a as {entry: HistoryEntry}).entry.time)
		const name = (overlay: Overlay | undefined) => overlayName(props.overlays, overlay ?? null)
		const heads: Row[] = merging
			? [{kind: "working", lane: 0, label: "Merge result", meta: "now"}]
			: [
					{kind: "working", lane: 0, label: "Working copy", meta: name(left())},
					{kind: "working", lane: 1, label: "Working copy", meta: name(right())},
				]
		const shared = ours.filter(entry => inRight.has(entry.id)).length
		return [...heads, ...own, ...(shared ? [{kind: "parted", lane: 0, count: shared} as Row] : [])]
	})

	// Which row each mark goes on.
	const badges = createMemo(() => {
		const out = new Map<string, Badge>()
		const list = rows()
		const current = range()
		if (current) {
			out.set(current.later ?? "working-0", {label: "B", tone: "neutral"})
			if (current.earlier) out.set(current.earlier, {label: "A", tone: "neutral"})
		}
		if (merge()) {
			const newest = (lane: Lane) => list.find(row => row.kind === "entry" && row.lane === lane)
			const into = newest(0)
			const to = newest(1)
			if (into) out.set(keyOf(into), {label: "into", tone: "b"})
			if (to) out.set(keyOf(to), {label: "to", tone: "a"})
			if (list.some(row => row.kind === "parted")) out.set("parted", {label: "from", tone: "neutral"})
		}
		return out
	})

	// The point each lane is at: in one lane, what's checked out; comparing,
	// A's (checked out) on the right and B's (compared with) on the left.
	const selected = (row: Row) => {
		if (merge() || row.kind === "parted") return false
		const compared = pair()
		const at = compared ? (row.lane === 1 ? compared.aAt : compared.bAt) : props.overlays.at
		return row.kind === "working" ? at === null : row.entry.id === at
	}
	// In a range: the rows from A to B, and those outside it, muted.
	const span = createMemo(() => {
		const current = range()
		if (!current) return undefined
		const list = rows()
		const index = (at: At) => list.findIndex(row => keyOf(row) === (at ?? "working-0"))
		const top = index(current.later)
		const bottom = index(current.earlier)
		return top < 0 || bottom < 0 ? undefined : {top: Math.min(top, bottom), bottom: Math.max(top, bottom)}
	})
	const muted = (index: number) => {
		const current = span()
		return !!current && (index < current.top || index > current.bottom)
	}
	const pickable = (row: Row) => !merge() && row.kind !== "parted"

	const pick = async (row: Row, event: MouseEvent) => {
		if (!pickable(row) || row.kind === "parted") return
		const at: At = row.kind === "working" ? null : row.entry.id
		// Comparing two versions: a point in either lane moves that side,
		// and they stay compared.
		const compared = pair()
		if (compared) {
			if (row.lane === 1) await send({type: "overlay:checkout", overlay: compared.a, at})
			else await send({type: "compare:set", overlay: compared.b, at})
			return
		}
		const overlay = props.overlays.checkedOut
		const from = props.overlays.at
		if (!event.shiftKey || from === at) {
			if (props.comparison) await send({type: "compare:clear"})
			await send({type: "overlay:checkout", overlay, at})
			return
		}
		// The later of the two is checked out, the earlier compared with it.
		const list = rows()
		const index = (point: At) => list.findIndex(each => keyOf(each) === (point ?? "working-0"))
		const [later, earlier] = index(at) < index(from) ? [at, from] : [from, at]
		if (props.overlays.at !== later) await send({type: "overlay:checkout", overlay, at: later})
		await send({type: "compare:set", overlay, at: earlier})
	}

	const colorOf = (lane: Lane) => {
		if (right() === undefined) return "var(--projects-history-line)"
		if (merge()) return lane === 1 ? "var(--compare-b)" : "var(--compare-a)"
		return lane === 1 ? "var(--compare-a)" : "var(--compare-b)"
	}

	return (
		<aside class="projects__history" classList={{"projects__history--open": open()}} aria-label="History">
			<Show
				when={open()}
				fallback={
					<button
						type="button"
						class="projects__history-rail"
						title="Show history"
						aria-label="Show history"
						onClick={toggle}>
						<ClockIcon />
						<svg class="projects__history-dots" width="40" height={rows().length * 24 + 8} aria-hidden="true">
							<line x1="20" y1="12" x2="20" y2={Math.max(12, (rows().length - 1) * 24 + 12)} />
							<For each={rows()}>
								{(row, i) => (
									<circle
										cx="20"
										cy={i() * 24 + 12}
										r={selected(row) ? 4 : row.kind === "working" ? 4.5 : 3}
										class={
											row.kind === "working"
												? "projects__history-dot--working"
												: selected(row)
													? "projects__history-dot--selected"
													: "projects__history-dot"
										}
									/>
								)}
							</For>
						</svg>
					</button>
				}>
				<header class="projects__history-header">
					<ClockIcon />
					<span class="projects__history-title">History</span>
					<button
						type="button"
						class="projects__history-close"
						title="Hide history"
						aria-label="Hide history"
						onClick={toggle}>
						<ChevronLeftIcon />
					</button>
				</header>
				<div class="projects__history-scroll">
					<div class="projects__history-list" style={{height: `${rows().length * ROW + 8}px`}}>
						<Show when={span()}>
							{current => (
								<div
									class="projects__history-span"
									style={{
										top: `${current().top * ROW + 4}px`,
										height: `${(current().bottom - current().top + 1) * ROW - 8}px`,
									}}
								/>
							)}
						</Show>
						<Lanes rows={rows()} colorOf={colorOf} selected={row => !!pair() && selected(row)} />
						<For each={rows()}>
							{(row, i) => (
								<button
									type="button"
									class="projects__history-row"
									classList={{
										"projects__history-row--muted": muted(i()) || row.kind === "parted",
										"projects__history-row--selected": selected(row),
										"projects__history-row--static": !pickable(row),
									}}
									style={{top: `${i() * ROW}px`, "padding-left": `${TEXT_X[row.lane]}px`}}
									disabled={!pickable(row)}
									title={titleOf(row, !!pair(), !!merge())}
									onClick={event => void pick(row, event)}>
									<span
										class="projects__history-row-title"
										classList={{"projects__history-row-title--working": row.kind === "working"}}>
										{row.kind === "working"
											? row.label
											: row.kind === "parted"
												? "Before they parted"
												: ago(row.entry.time, now())}
									</span>
									<Show when={badges().get(keyOf(row))}>
										{badge => (
											<span class={`projects__history-badge projects__history-badge--${badge().tone}`}>
												{badge().label}
											</span>
										)}
									</Show>
									<span class="projects__history-row-meta">
										{row.kind === "working"
											? row.meta
											: row.kind === "parted"
												? row.count === 1
													? "1 entry they share"
													: `${row.count} entries they share`
												: row.lane === 1
													? when(row.entry.time, now())
													: metaOf(row.entry, now())}
									</span>
								</button>
							)}
						</For>
					</div>
				</div>
			</Show>
		</aside>
	)
}

function titleOf(row: Row, comparing: boolean, merging: boolean): string | undefined {
	if (merging || row.kind === "parted") return undefined
	if (comparing) return row.lane === 1 ? "Check this point out" : "Compare with this point"
	return row.kind === "working"
		? "Back to the working copy"
		: "View as it was then; shift-click another to compare"
}

// The lines down each lane and its dots. A second lane runs down to where
// the two parted, and joins the first there.
function Lanes(props: {rows: Row[]; colorOf(lane: Lane): string; selected(row: Row): boolean}) {
	const y = (index: number) => index * ROW + ROW / 2
	const path = createMemo(() => {
		const rows = props.rows
		const first = (lane: Lane) => rows.findIndex(row => row.lane === lane && row.kind !== "parted")
		let lane0Last = -1
		let lane1Last = -1
		rows.forEach((row, i) => {
			if (row.kind === "parted") return
			if (row.lane === 0) lane0Last = i
			else lane1Last = i
		})
		const parted = rows.findIndex(row => row.kind === "parted")
		return {lane0: first(0), lane1: first(1), lane0Last, lane1Last, parted}
	})
	const end0 = () => (path().parted >= 0 ? path().parted : path().lane0Last)
	return (
		<svg class="projects__history-lanes" width="100%" height={props.rows.length * ROW + 8} aria-hidden="true">
			<Show when={path().lane0 >= 0 && end0() > path().lane0}>
				<line
					x1={LANE_X[0]}
					y1={y(path().lane0)}
					x2={LANE_X[0]}
					y2={y(end0())}
					stroke={props.colorOf(0)}
					stroke-width="2"
				/>
			</Show>
			<Show when={path().lane1 >= 0}>
				<path
					d={
						path().parted >= 0
							? `M${LANE_X[1]},${y(path().lane1)} V${y(path().parted) - 34} C${LANE_X[1]},${y(path().parted) - 12} ${LANE_X[0]},${y(path().parted) - 22} ${LANE_X[0]},${y(path().parted)}`
							: `M${LANE_X[1]},${y(path().lane1)} V${y(path().lane1Last)}`
					}
					fill="none"
					stroke={props.colorOf(1)}
					stroke-width="2"
				/>
			</Show>
			<For each={props.rows}>
				{(row, i) => (
					<circle
						cx={LANE_X[row.lane]}
						cy={y(i())}
						r={props.selected(row) ? 6 : 4.5}
						class={
							row.kind === "working"
								? "projects__history-dot--working"
								: row.kind === "parted"
									? "projects__history-dot--parted"
									: "projects__history-dot"
						}
						classList={{"projects__history-dot--chosen": props.selected(row)}}
						style={row.kind === "working" ? {stroke: props.colorOf(row.lane)} : row.kind === "entry" ? {fill: props.colorOf(row.lane)} : {}}
					/>
				)}
			</For>
		</svg>
	)
}

function metaOf(entry: HistoryEntry, now: number): string {
	const files = entry.members.length
	return `${when(entry.time, now)} · ${files === 1 ? "1 document" : `${files} documents`}`
}

function readOpen(): boolean {
	try {
		return localStorage.getItem(OPEN_KEY) === "open"
	} catch {
		return false
	}
}

// lucide `clock`
function ClockIcon() {
	return (
		<svg
			class="projects__history-icon"
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
			<circle cx="12" cy="12" r="10" />
			<path d="M12 6v6l4 2" />
		</svg>
	)
}

// lucide `chevron-left`
function ChevronLeftIcon() {
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
			<path d="m15 18-6-6 6-6" />
		</svg>
	)
}
