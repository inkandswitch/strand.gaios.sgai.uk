import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {request, subscribe, type Selector} from "@inkandswitch/patchwork-providers"
import {createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor} from "solid-js"
import {folderLinks} from "./folders.ts"
import type {PanelScope} from "./side-panels.ts"
import {
	historyShown,
	overlayName,
	type At,
	type Comparison,
	type HistoryEntry,
	type Member,
	type Overlay,
	type OverlaysState,
} from "./types.ts"

// A burst still going: its last change is more recent than this, so it's
// the working copy rather than an entry of its own yet.
const OPEN_ENTRY_SECONDS = 10 * 60

const ROW = 34
const LANE_X = [12, 26] as const
const TEXT_X = 40

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

/** What each member of the root is called in its folder, by its url. */
export type MemberNames = Accessor<Map<AutomergeUrl, string>>

/**
 * The names of `overlay`'s members, from the folders they're in (a folder's
 * with a slash after it), kept current as they're renamed or added.
 */
export function useMemberNames(
	element: Accessor<HTMLElement | undefined>,
	repo: Repo,
	overlay: Accessor<Overlay | undefined>
): MemberNames {
	const [folders, setFolders] = createSignal<AutomergeUrl[]>([], {
		equals: (a, b) => a.length === b.length && a.every((url, i) => url === b[i]),
	})
	createEffect(() => {
		const at = element()
		const which = overlay()
		if (!at || which === undefined) return
		const selector = {type: "overlay:members", overlay: which} as Selector
		onCleanup(
			subscribe<Member[]>(at, selector, members => {
				const parents = new Set<AutomergeUrl>()
				for (const member of members ?? []) if (member.parent) parents.add(member.parent)
				setFolders([...parents].sort())
			})
		)
	})
	const [names, setNames] = createSignal(new Map<AutomergeUrl, string>())
	createEffect(() => {
		const urls = folders()
		const byFolder = new Map<AutomergeUrl, Map<AutomergeUrl, string>>()
		const stops: (() => void)[] = []
		let live = true
		const publish = () => {
			const out = new Map<AutomergeUrl, string>()
			for (const each of byFolder.values()) for (const [url, name] of each) out.set(url, name)
			setNames(out)
		}
		for (const url of urls) {
			repo.find(url).then(
				handle => {
					if (!live) return
					const update = () => {
						const links = folderLinks(handle.doc())
						byFolder.set(
							url,
							new Map(links.map(link => [link.url, link.type === "folder" ? `${link.name}/` : link.name]))
						)
						publish()
					}
					update()
					handle.on("change", update)
					stops.push(() => handle.off("change", update))
				},
				() => {}
			)
		}
		onCleanup(() => {
			live = false
			for (const stop of stops) stop()
		})
	})
	return names
}

/** Seconds since the epoch, ticking every half minute, for "how long ago". */
export function useNow(): Accessor<number> {
	const [now, setNow] = createSignal(Date.now() / 1000)
	const timer = setInterval(() => setNow(Date.now() / 1000), 30_000)
	onCleanup(() => clearInterval(timer))
	return now
}

/** How long ago `time` (Unix seconds) was, in words. */
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

/** How long ago `time` was, as short as it goes: "5m", "2h", "3d". */
export function short(time: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - time) / 60)
	if (minutes < 1) return "now"
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h`
	const days = Math.floor(hours / 24)
	if (days < 30) return `${days}d`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo`
	return `${Math.max(1, Math.floor(days / 365))}y`
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

/**
 * What an entry is called: the documents it changed (folders only when it
 * changed nothing else), or, failing those, how long ago it was.
 */
export function entryTitle(entry: HistoryEntry, names: Map<AutomergeUrl, string>, now: number): string {
	const all = entry.members.map(url => names.get(url)).filter((name): name is string => !!name)
	const documents = all.filter(name => !name.endsWith("/"))
	const shown = documents.length > 0 ? documents : all
	if (shown.length === 0) return ago(entry.time, now)
	return shown.length <= 2 ? shown.join(", ") : `${shown.slice(0, 2).join(", ")} +${shown.length - 2}`
}

/** What a point in history is called: its entry's title, or the working copy. */
export function pointName(
	entries: HistoryEntry[] | undefined,
	at: At,
	names: Map<AutomergeUrl, string>,
	now: number
): string {
	if (at === null) return "Working copy"
	const entry = entries?.find(each => each.id === at)
	return entry ? entryTitle(entry, names, now) : "Earlier"
}

type Lane = 0 | 1

type Row =
	// A lane's working copy, or the merge's result, at its top.
	| {kind: "head"; lane: Lane; label: string; meta: string}
	// `shared`: from before two versions parted, in the first lane.
	| {kind: "entry"; entry: HistoryEntry; lane: Lane; shared: boolean}

const keyOf = (row: Row) => (row.kind === "head" ? `head-${row.lane}` : row.entry.id)

/** What a row's marked with, at its end: a point of a range, or what it is to a merge. */
type Mark = {letter: "A" | "B"} | {word: string; tone: "a" | "b" | "neutral"}

/**
 * The history, in the column beside the card. One lane for the checked-out
 * overlay, with its working copy at the top: clicking an entry views it,
 * read-only, and shift-clicking another compares the two. While two
 * overlays are compared or merged, a lane for each down to where they
 * parted, and then the history they share. With the scope at the open
 * documents, only the entries that changed one of them.
 */
export function HistoryPanel(props: {
	element: HTMLElement
	overlays: OverlaysState
	comparison: Comparison
	names: Map<AutomergeUrl, string>
	openDocs: AutomergeUrl[]
	scope: PanelScope
}) {
	const now = useNow()
	const send = (selector: Record<string, unknown>) => request(props.element, selector as Selector)
	const element = () => props.element

	const merge = () => (props.comparison?.kind === "merge" ? props.comparison : undefined)
	const pair = () =>
		props.comparison?.kind === "compare" && !historyShown(props.comparison) ? props.comparison : undefined
	// The lanes: one overlay, or two side by side: what's checked out and
	// what it's compared with, or a merge's target and its source.
	const first = () => {
		const merging = merge()
		if (merging) return merging.target
		const compared = pair()
		return compared ? compared.a : props.overlays.checkedOut
	}
	const second = () => {
		const merging = merge()
		if (merging) return merging.source
		const compared = pair()
		return compared ? compared.b : undefined
	}
	const firstEntries = useHistory(element, first)
	const secondEntries = useHistory(element, second)
	const twoLanes = () => second() !== undefined

	// Two points in one history: the later checked out, the earlier compared.
	const range = () =>
		historyShown(props.comparison) && props.comparison?.kind === "compare"
			? {later: props.comparison.aAt, earlier: props.comparison.bAt}
			: undefined

	const inScope = createMemo(() => {
		if (props.scope !== "open") return () => true
		const open = new Set(props.openDocs)
		return (entry: HistoryEntry) => entry.members.some(url => open.has(url))
	})

	const rows = createMemo<Row[]>(() => {
		const shown = inScope()
		const ours = firstEntries() ?? []
		if (!twoLanes()) {
			const going = openEntry(ours, now())
			return [
				{kind: "head", lane: 0, label: "Working copy", meta: "now"},
				...ours
					.filter(entry => entry !== going && shown(entry))
					.map(entry => ({kind: "entry", entry, lane: 0, shared: false}) as Row),
			]
		}
		// Two lanes: what each has of its own since they parted, newest
		// first, then what they share.
		const theirs = secondEntries() ?? []
		const inFirst = new Set(ours.map(entry => entry.id))
		const inSecond = new Set(theirs.map(entry => entry.id))
		const merging = !!merge()
		// Comparing, each lane's working copy heads it, and a burst still
		// going is that working copy.
		const settled = (own: HistoryEntry[]) => {
			const going = merging ? undefined : openEntry(own, now())
			return own.filter(entry => entry !== going && shown(entry))
		}
		const own: Row[] = [
			...settled(ours.filter(entry => !inSecond.has(entry.id))).map(
				entry => ({kind: "entry", entry, lane: 0, shared: false}) as Row
			),
			...settled(theirs.filter(entry => !inFirst.has(entry.id))).map(
				entry => ({kind: "entry", entry, lane: 1, shared: false}) as Row
			),
		].sort((a, b) => (b as {entry: HistoryEntry}).entry.time - (a as {entry: HistoryEntry}).entry.time)
		const name = (overlay: Overlay | undefined) => overlayName(props.overlays, overlay ?? null)
		const heads: Row[] = merging
			? [{kind: "head", lane: 0, label: "Merge result", meta: merge()!.published ? "draft" : "preview"}]
			: [
					{kind: "head", lane: 0, label: name(first()), meta: "now"},
					{kind: "head", lane: 1, label: name(second()), meta: "now"},
				]
		// Where they parted stays, whatever the scope.
		const shared = ours
			.filter(entry => inSecond.has(entry.id))
			.filter((entry, i) => i === 0 || shown(entry))
			.map(entry => ({kind: "entry", entry, lane: 0, shared: true}) as Row)
		return [...heads, ...own, ...shared]
	})

	// Where the two lanes join: the newest entry they share.
	const fork = () => rows().findIndex(row => row.kind === "entry" && row.shared)

	const marks = createMemo(() => {
		const out = new Map<string, Mark>()
		const list = rows()
		const current = range()
		if (current) {
			out.set(current.later ?? "head-0", {letter: "B"})
			if (current.earlier) out.set(current.earlier, {letter: "A"})
		}
		const parted = list[fork()]
		if (merge()) {
			const newest = (lane: Lane) =>
				list.find(row => row.kind === "entry" && !row.shared && row.lane === lane)
			const into = newest(0)
			const to = newest(1)
			if (into) out.set(keyOf(into), {word: "into", tone: "a"})
			if (to) out.set(keyOf(to), {word: "to", tone: "b"})
			if (parted) out.set(keyOf(parted), {word: "from", tone: "neutral"})
		} else if (parted) out.set(keyOf(parted), {word: "fork", tone: "neutral"})
		return out
	})

	// The point each lane is at: in one lane, what's checked out; comparing,
	// the checked-out one's in the first and the compared one's in the second.
	const selected = (row: Row) => {
		if (merge() || (row.kind === "entry" && row.shared)) return false
		const compared = pair()
		const at = compared ? (row.lane === 0 ? compared.aAt : compared.bAt) : props.overlays.at
		return row.kind === "head" ? at === null : row.entry.id === at
	}
	// In a range: the rows from A to B; those outside it are muted.
	const span = createMemo(() => {
		const current = range()
		if (!current) return undefined
		const list = rows()
		const index = (at: At) => list.findIndex(row => keyOf(row) === (at ?? "head-0"))
		const top = index(current.later)
		const bottom = index(current.earlier)
		return top < 0 || bottom < 0 ? undefined : {top: Math.min(top, bottom), bottom: Math.max(top, bottom)}
	})
	const muted = (index: number) => {
		const row = rows()[index]
		if (row?.kind === "entry" && row.shared) return index !== fork()
		const current = span()
		return !!current && (index < current.top || index > current.bottom)
	}
	const pickable = (row: Row) => !merge() && !(row.kind === "entry" && row.shared && pair())

	const pick = async (row: Row, event: MouseEvent) => {
		if (!pickable(row)) return
		const at: At = row.kind === "head" ? null : row.entry.id
		// Comparing two versions: a point in either lane moves that side,
		// and they stay compared.
		const compared = pair()
		if (compared) {
			if (row.lane === 0) await send({type: "overlay:checkout", overlay: compared.a, at})
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
		const index = (point: At) => list.findIndex(each => keyOf(each) === (point ?? "head-0"))
		const [later, earlier] = index(at) < index(from) ? [at, from] : [from, at]
		if (props.overlays.at !== later) await send({type: "overlay:checkout", overlay, at: later})
		await send({type: "compare:set", overlay, at: earlier})
	}

	// Colour only while two versions are on screen: the first lane in A's,
	// the second in B's.
	const colorOf = (lane: Lane) =>
		!twoLanes() ? "var(--projects-history-line)" : lane === 0 ? "var(--compare-a)" : "var(--compare-b)"

	return (
		<div class="projects__history" classList={{"projects__history--two": twoLanes()}}>
			<div class="projects__history-list" style={{height: `${rows().length * ROW}px`}}>
				<Show when={span()}>
					{current => (
						<div
							class="projects__history-span"
							style={{
								top: `${current().top * ROW}px`,
								height: `${(current().bottom - current().top + 1) * ROW}px`,
							}}
						/>
					)}
				</Show>
				<Lanes
					rows={rows()}
					fork={fork()}
					merging={!!merge()}
					colorOf={colorOf}
					muted={muted}
					selected={row => !!pair() && selected(row)}
					ringed={row => {
						const mark = marks().get(keyOf(row))
						return !!mark && "word" in mark && mark.word === "into"
					}}
				/>
				<For each={rows()}>
					{(row, i) => (
						<button
							type="button"
							class="projects__history-row"
							classList={{
								"projects__history-row--muted": muted(i()),
								"projects__history-row--selected": selected(row),
								"projects__history-row--static": !pickable(row),
								"projects__history-row--result": row.kind === "head" && !!merge(),
							}}
							style={{top: `${i() * ROW}px`, "padding-left": `${TEXT_X}px`}}
							disabled={!pickable(row)}
							title={titleOf(row, now(), !!pair(), !!merge())}
							onClick={event => void pick(row, event)}>
							<span class="projects__history-row-title">
								{row.kind === "head" ? row.label : entryTitle(row.entry, props.names, now())}
							</span>
							<Show when={marks().get(keyOf(row))}>
								{mark => {
									const current = mark()
									return "letter" in current ? (
										<span class="projects__point-badge">{current.letter}</span>
									) : (
										<span class={`projects__history-mark projects__history-mark--${current.tone}`}>
											{current.word}
										</span>
									)
								}}
							</Show>
							<span class="projects__history-row-time">
								{row.kind === "head" ? row.meta : short(row.entry.time, now())}
							</span>
						</button>
					)}
				</For>
			</div>
		</div>
	)
}

function titleOf(row: Row, now: number, comparing: boolean, merging: boolean): string | undefined {
	const time = row.kind === "entry" ? `${ago(row.entry.time, now)} · ${when(row.entry.time, now)}` : undefined
	if (merging || (row.kind === "entry" && row.shared && comparing)) return time
	const hint = comparing
		? row.lane === 0
			? "Check this point out"
			: "Compare with this point"
		: row.kind === "head"
			? "Back to the working copy"
			: "View as it was then; shift-click another to compare"
	return time ? `${time}\n${hint}` : hint
}

// The lines down each lane and its dots. The second lane runs down to where
// the two parted, and joins the first there; past that, what they share is
// drawn faint. A head's line, to the first entry below it, is dashed.
function Lanes(props: {
	rows: Row[]
	fork: number
	merging: boolean
	colorOf(lane: Lane): string
	muted(index: number): boolean
	selected(row: Row): boolean
	ringed(row: Row): boolean
}) {
	const y = (index: number) => index * ROW + ROW / 2
	const faint = "var(--projects-faint)"
	const segments = createMemo(() => {
		const out: {d: string; color: string; dashed: boolean}[] = []
		const rows = props.rows
		for (const lane of [0, 1] as const) {
			const indices = rows.flatMap((row, i) => (row.lane === lane ? [i] : []))
			for (let k = 0; k + 1 < indices.length; k++) {
				const from = indices[k]
				const to = indices[k + 1]
				const dim = props.muted(from) || props.muted(to) || (props.fork >= 0 && from >= props.fork)
				out.push({
					d: `M${LANE_X[lane]},${y(from)} V${y(to)}`,
					color: dim ? faint : props.colorOf(lane),
					dashed: rows[from].kind === "head",
				})
			}
		}
		// The second lane bends into the first where they parted.
		const last = rows.reduce((found, row, i) => (row.lane === 1 ? i : found), -1)
		if (last >= 0 && props.fork > last) {
			const at = y(props.fork)
			out.push({
				d: `M${LANE_X[1]},${y(last)} V${at - 12} Q${LANE_X[1]},${at} ${LANE_X[0] + 5},${at}`,
				color: props.colorOf(1),
				dashed: rows[last].kind === "head",
			})
		}
		// A merge's source rises into its result.
		const firstSource = rows.findIndex(row => row.lane === 1)
		if (props.merging && firstSource > 0) {
			out.push({
				d: `M${LANE_X[1]},${y(firstSource) - 6} V${y(0) + 8} Q${LANE_X[1]},${y(0)} ${LANE_X[0] + 6},${y(0)}`,
				color: props.colorOf(1),
				dashed: true,
			})
		}
		return out
	})
	return (
		<svg class="projects__history-lanes" width="100%" height={props.rows.length * ROW} aria-hidden="true">
			<For each={segments()}>
				{segment => (
					<path
						d={segment.d}
						fill="none"
						stroke={segment.color}
						stroke-width={segment.dashed ? 1.5 : 1.8}
						stroke-dasharray={segment.dashed ? "3 3" : undefined}
					/>
				)}
			</For>
			<For each={props.rows}>
				{(row, i) => {
					const x = LANE_X[row.lane]
					const color = () => (props.muted(i()) ? faint : props.colorOf(row.lane))
					if (row.kind === "head")
						return (
							<circle
								cx={x}
								cy={y(i())}
								r={5}
								class="projects__history-dot--head"
								classList={{"projects__history-dot--chosen": props.selected(row)}}
								style={{stroke: color()}}
							/>
						)
					return (
						<Show
							when={!props.ringed(row) && !props.selected(row)}
							fallback={
								<>
									<circle cx={x} cy={y(i())} r={5.5} class="projects__history-dot--ring" style={{stroke: color()}} />
									<circle cx={x} cy={y(i())} r={2.6} style={{fill: color()}} />
								</>
							}>
							<circle
								cx={x}
								cy={y(i())}
								r={i() === props.fork ? 4 : props.muted(i()) ? 3 : 3.4}
								style={{fill: i() === props.fork ? "var(--projects-secondary)" : color()}}
							/>
						</Show>
					)
				}}
			</For>
		</svg>
	)
}
