import {request, subscribe, type Selector} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor} from "solid-js"
import {
	historyShown,
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
	| {kind: "working"; lane: Lane; label: string}
	| {kind: "entry"; entry: HistoryEntry; lane: Lane; shared: boolean}

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
				{kind: "working", lane: 0, label: "Working copy"},
				...ours
					.filter(entry => entry !== going)
					.map(entry => ({kind: "entry", entry, lane: 0, shared: false}) as Row),
			]
		}
		const theirs = rightEntries() ?? []
		const inLeft = new Set(ours.map(entry => entry.id))
		const inRight = new Set(theirs.map(entry => entry.id))
		const all = new Map<string, HistoryEntry>()
		for (const entry of [...ours, ...theirs]) all.set(entry.id, entry)
		const sorted = [...all.values()].sort((a, b) => b.time - a.time)
		const out: Row[] = merge() ? [{kind: "working", lane: 0, label: "Merge result"}] : []
		for (const entry of sorted) {
			const shared = inLeft.has(entry.id) && inRight.has(entry.id)
			out.push({kind: "entry", entry, lane: shared || inLeft.has(entry.id) ? 0 : 1, shared})
		}
		return out
	})

	// Which row each mark goes on.
	const badges = createMemo(() => {
		const out = new Map<string, Badge>()
		const list = rows()
		const keyOf = (row: Row) => (row.kind === "working" ? "working" : row.entry.id)
		const current = range()
		if (current) {
			out.set(current.later ?? "working", {label: "B", tone: "neutral"})
			if (current.earlier) out.set(current.earlier, {label: "A", tone: "neutral"})
		}
		const merging = merge()
		if (merging) {
			const own = (lane: Lane) =>
				list.find(row => row.kind === "entry" && row.lane === lane && !row.shared)
			const into = own(0)
			const to = own(1)
			const from = list.find(row => row.kind === "entry" && row.shared)
			if (into) out.set(keyOf(into), {label: "into", tone: "b"})
			if (to) out.set(keyOf(to), {label: "to", tone: "a"})
			if (from) out.set(keyOf(from), {label: "from", tone: "neutral"})
		}
		return out
	})

	const selected = (row: Row) => {
		if (merge() || pair()) return false
		const at = props.overlays.at
		return row.kind === "working" ? at === null : row.entry.id === at
	}
	// In a range: the rows from A to B, and those outside it, muted.
	const span = createMemo(() => {
		const current = range()
		if (!current) return undefined
		const list = rows()
		const index = (at: At) =>
			list.findIndex(row => (at === null ? row.kind === "working" : row.kind === "entry" && row.entry.id === at))
		const top = index(current.later)
		const bottom = index(current.earlier)
		return top < 0 || bottom < 0 ? undefined : {top: Math.min(top, bottom), bottom: Math.max(top, bottom)}
	})
	const muted = (index: number) => {
		const current = span()
		return !!current && (index < current.top || index > current.bottom)
	}

	const pick = async (row: Row, event: MouseEvent) => {
		if (merge()) return
		// In two lanes, an entry views its own lane's overlay; one both share,
		// the checked-out one.
		const overlay =
			pair() && row.kind === "entry" && !row.shared
				? row.lane === 1
					? right()!
					: left()!
				: props.overlays.checkedOut
		const at: At = row.kind === "working" ? null : row.entry.id
		const from = props.overlays.at
		const extending = event.shiftKey && !pair() && from !== at && overlay === props.overlays.checkedOut
		if (!extending) {
			if (props.comparison) await send({type: "compare:clear"})
			await send({type: "overlay:checkout", overlay, at})
			return
		}
		// The later of the two is checked out, the earlier compared with it.
		const list = rows()
		const index = (point: At) =>
			list.findIndex(each => (point === null ? each.kind === "working" : each.kind === "entry" && each.entry.id === point))
		const [later, earlier] = index(at) < index(from) ? [at, from] : [from, at]
		if (props.overlays.at !== later) await send({type: "overlay:checkout", overlay, at: later})
		await send({type: "compare:set", overlay, at: earlier})
	}

	const colorOf = (lane: Lane, shared: boolean) => {
		if (shared || right() === undefined) return "var(--projects-history-line)"
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
						<Lanes rows={rows()} colorOf={colorOf} twoLanes={right() !== undefined} />
						<For each={rows()}>
							{(row, i) => (
								<button
									type="button"
									class="projects__history-row"
									classList={{
										"projects__history-row--muted": muted(i()) || (row.kind === "entry" && row.shared && !!pair()),
										"projects__history-row--selected": selected(row),
										"projects__history-row--static": !!merge(),
									}}
									style={{top: `${i() * ROW}px`, "padding-left": `${TEXT_X[row.lane]}px`}}
									disabled={!!merge()}
									title={
										merge()
											? undefined
											: row.kind === "working"
												? "Back to the working copy"
												: "View as it was then; shift-click another to compare"
									}
									onClick={event => void pick(row, event)}>
									<span class="projects__history-row-title" classList={{"projects__history-row-title--working": row.kind === "working"}}>
										{row.kind === "working" ? row.label : ago(row.entry.time, now())}
									</span>
									<Show when={badges().get(row.kind === "working" ? "working" : row.entry.id)}>
										{badge => (
											<span class={`projects__history-badge projects__history-badge--${badge().tone}`}>
												{badge().label}
											</span>
										)}
									</Show>
									<span class="projects__history-row-meta">
										{row.kind === "working"
											? "now"
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

// The lines down each lane and its dots. A second lane runs down to the
// newest entry both share, where it joins the first.
function Lanes(props: {rows: Row[]; colorOf(lane: Lane, shared: boolean): string; twoLanes: boolean}) {
	const y = (index: number) => index * ROW + ROW / 2
	const path = createMemo(() => {
		const rows = props.rows
		const lane0 = rows.findIndex(row => row.lane === 0)
		const lane1First = rows.findIndex(row => row.lane === 1)
		let lane1Last = -1
		rows.forEach((row, i) => {
			if (row.lane === 1) lane1Last = i
		})
		const fork = rows.findIndex((row, i) => i > lane1Last && row.kind === "entry" && row.shared)
		const sharedFirst = rows.findIndex(row => row.kind === "entry" && row.shared)
		return {lane0, lane1First, lane1Last, fork, sharedFirst, last: rows.length - 1}
	})
	return (
		<svg class="projects__history-lanes" width="290" height={props.rows.length * ROW + 8} aria-hidden="true">
			<Show when={path().lane0 >= 0}>
				{/* the first lane, in its colour down to what's shared */}
				<line
					x1={LANE_X[0]}
					y1={y(path().lane0)}
					x2={LANE_X[0]}
					y2={y(props.twoLanes && path().sharedFirst >= 0 ? path().sharedFirst : path().last)}
					stroke={props.colorOf(0, false)}
					stroke-width="2"
				/>
				<Show when={props.twoLanes && path().sharedFirst >= 0}>
					<line
						x1={LANE_X[0]}
						y1={y(path().sharedFirst)}
						x2={LANE_X[0]}
						y2={y(path().last)}
						stroke={props.colorOf(0, true)}
						stroke-width="1.5"
					/>
				</Show>
			</Show>
			<Show when={path().lane1First >= 0}>
				<path
					d={
						path().fork >= 0
							? `M${LANE_X[1]},${y(path().lane1First)} V${y(path().fork) - 34} C${LANE_X[1]},${y(path().fork) - 12} ${LANE_X[0]},${y(path().fork) - 22} ${LANE_X[0]},${y(path().fork)}`
							: `M${LANE_X[1]},${y(path().lane1First)} V${y(path().lane1Last)}`
					}
					fill="none"
					stroke={props.colorOf(1, false)}
					stroke-width="2"
				/>
			</Show>
			<For each={props.rows}>
				{(row, i) => (
					<circle
						cx={LANE_X[row.lane]}
						cy={y(i())}
						r={row.kind === "working" ? 4.5 : 4.5}
						class={row.kind === "working" ? "projects__history-dot--working" : "projects__history-dot"}
						style={
							row.kind === "working"
								? {stroke: props.colorOf(row.lane, false)}
								: {fill: props.colorOf(row.lane, row.shared)}
						}
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
