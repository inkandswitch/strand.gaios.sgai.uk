import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {request, subscribe, type JSONValue} from "@inkandswitch/patchwork-providers"
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	type Accessor,
	type JSX,
} from "solid-js"

/** A draft on the way from main to the checked-out one. Main's url is null. */
export type Lane = {url: AutomergeUrl | null; name: string}

type LaneKind = "main" | "ancestor" | "current"
type Stroke = {d: string; kind: LaneKind}
type Dot = {x: number; y: number; r: number; kind: LaneKind}

// What the draft and review providers answer, as far as it's read here.
type DraftList = {
	main: {name: string | null}
	drafts: {url: AutomergeUrl; parent: AutomergeUrl | null; name: string | null}[]
}
type DraftSelection = {checkedOut: AutomergeUrl | null}
type ChangeView = {status: "main" | "loading" | "ready"; onlyChanged: boolean}

// Geometry, in pixels. Older drafts show as strips this wide, each the left
// edge of a card tucked behind the next.
const STRIP = 40
const MAX_STRIPS = 4
const STRIP_LANE_TOP = 112
const CARD_GUTTER = 30
const CARD_LANE_X = 16
const CARD_LANE_TOP = 66
const BOTTOM = 28
const FORK_GAP = 96
const ELBOW = 10

/**
 * The checked-out draft as a card, with the drafts it was forked from tucked
 * behind it as strips, oldest leftmost. Each draft's history runs down its
 * strip, and forks off its parent's. Clicking a strip checks that draft out.
 */
export function DraftStack(props: {
	element: Accessor<HTMLElement | undefined>
	lanes: Lane[]
	children: JSX.Element
}) {
	const strips = () => visibleStrips(props.lanes)
	const current = () => props.lanes.at(-1)
	const changes = useSubscription<ChangeView>(props.element, {type: "review:changes"})
	const [height, setHeight] = createSignal(0)
	let stack!: HTMLDivElement

	createEffect(() => {
		const observer = new ResizeObserver(([entry]) =>
			setHeight(entry.contentRect.height)
		)
		observer.observe(stack)
		onCleanup(() => observer.disconnect())
	})

	const send = (selector: {type: string} & Record<string, JSONValue>) => {
		const element = props.element()
		if (element) void request(element, selector)
	}
	const open = (lane: Lane) =>
		send({type: "draft:select", checkedOut: lane.url, at: null})
	const toggleChanged = () =>
		send({type: "review:show-changed", onlyChanged: !changes()?.onlyChanged})

	return (
		<div
			ref={stack}
			class="draft-stack"
			style={{
				"--draft-stack-strip": `${STRIP}px`,
				"--draft-stack-strips": strips().length,
				"--draft-stack-gutter": `${CARD_GUTTER}px`,
			}}>
			<For each={strips()}>
				{(lane, index) => (
					<button
						type="button"
						class="draft-stack__strip"
						style={{"--draft-stack-index": index()}}
						title={`Open ${lane.name}`}
						onClick={() => open(lane)}>
						<span class="draft-stack__strip-name">{lane.name}</span>
					</button>
				)}
			</For>
			<section class="draft-stack__card">
				<header class="draft-stack__header">
					<patchwork-view component="draft-picker" />
					<button
						type="button"
						class="draft-stack__changed"
						aria-pressed={changes()?.onlyChanged ?? false}
						disabled={!changes() || changes()?.status === "main"}
						title={
							changes()?.status === "main"
								? "Main is what drafts are compared against"
								: "Show only what this draft changed"
						}
						onClick={toggleChanged}>
						Changed
					</button>
				</header>
				<div class="draft-stack__body">{props.children}</div>
			</section>
			<Lanes lanes={[...strips(), ...(current() ? [current()!] : [])]} height={height()} />
		</div>
	)
}

/** How much wider the stack's strips make the sidebar. */
export function stripsWidth(lanes: Lane[]): string {
	return `${visibleStrips(lanes).length * STRIP}px`
}

/** Main, the drafts between, and the checked-out draft last; none until known. */
export function useDraftLanes(element: Accessor<HTMLElement | undefined>): Accessor<Lane[]> {
	const list = useSubscription<DraftList>(element, {type: "draft:list"})
	const selection = useSubscription<DraftSelection>(element, {type: "draft:selection"})
	return createMemo(() => {
		const drafts = list()
		const checkedOut = selection()?.checkedOut
		if (!drafts || checkedOut === undefined) return []
		return lanesTo(drafts, checkedOut)
	})
}

function Lanes(props: {lanes: Lane[]; height: number}) {
	const drawn = createMemo(() => drawLanes(props.lanes, props.height))
	return (
		<svg class="draft-stack__lanes" aria-hidden="true">
			<For each={drawn().strokes}>
				{stroke => <path class={`draft-stack__lane--${stroke.kind}`} d={stroke.d} />}
			</For>
			<For each={drawn().dots}>
				{dot => (
					<circle
						class={`draft-stack__dot--${dot.kind}`}
						cx={dot.x}
						cy={dot.y}
						r={dot.r}
					/>
				)}
			</For>
		</svg>
	)
}

// Each lane runs down from under its name to where it forked, then bends into
// its parent's, which has a dot there. The oldest shown runs to the bottom.
// Forks are spaced up from the bottom, oldest lowest.
function drawLanes(lanes: Lane[], height: number): {strokes: Stroke[]; dots: Dot[]} {
	const strokes: Stroke[] = []
	const dots: Dot[] = []
	const last = lanes.length - 1
	if (last < 0 || height <= 0) return {strokes, dots}

	const bottom = height - BOTTOM
	const gap = Math.min(FORK_GAP, (bottom - STRIP_LANE_TOP) / Math.max(last + 1, 2))
	const x = (k: number) => (k < last ? k * STRIP + STRIP / 2 : last * STRIP + CARD_LANE_X)
	const top = (k: number) => (k < last ? STRIP_LANE_TOP : CARD_LANE_TOP)
	const kind = (k: number): LaneKind =>
		lanes[k].url === null ? "main" : k === last ? "current" : "ancestor"

	for (let k = 0; k <= last; k++) {
		if (k === 0) {
			strokes.push({d: `M${x(k)} ${top(k)} V${height - 12}`, kind: kind(k)})
			continue
		}
		const fork = Math.max(bottom - (k - 1) * gap, top(k) + ELBOW * 2)
		strokes.push({
			d:
				`M${x(k)} ${top(k)} V${fork - ELBOW} ` +
				`Q${x(k)} ${fork} ${x(k) - ELBOW} ${fork} H${x(k - 1)}`,
			kind: kind(k),
		})
		dots.push({x: x(k - 1), y: fork, r: 3.5, kind: kind(k - 1)})
	}
	dots.push({x: x(last), y: top(last), r: 4.5, kind: kind(last)})
	return {strokes, dots}
}

function visibleStrips(lanes: Lane[]): Lane[] {
	return lanes.slice(0, -1).slice(-MAX_STRIPS)
}

function lanesTo(list: DraftList, checkedOut: AutomergeUrl | null): Lane[] {
	const main: Lane = {url: null, name: list.main.name ?? "Main"}
	if (checkedOut === null) return [main]
	const byUrl = new Map(list.drafts.map(draft => [draft.url, draft]))
	const lanes: Lane[] = []
	let draft = byUrl.get(checkedOut)
	while (draft && !lanes.some(lane => lane.url === draft!.url)) {
		lanes.unshift({url: draft.url, name: draft.name ?? "Draft"})
		draft = draft.parent ? byUrl.get(draft.parent) : undefined
	}
	return lanes.length ? [main, ...lanes] : []
}

function useSubscription<T extends JSONValue>(
	element: Accessor<HTMLElement | undefined>,
	selector: {type: string}
): Accessor<T | undefined> {
	const [value, setValue] = createSignal<T>()
	createEffect(() => {
		const current = element()
		if (!current) return
		onCleanup(subscribe<T>(current, selector, next => setValue(() => next)))
	})
	return value
}
