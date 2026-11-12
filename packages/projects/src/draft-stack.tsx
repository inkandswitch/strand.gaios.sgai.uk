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

// What the draft and review providers answer, as far as it's read here.
type DraftList = {
	main: {name: string | null}
	drafts: {url: AutomergeUrl; parent: AutomergeUrl | null; name: string | null}[]
}
type DraftSelection = {checkedOut: AutomergeUrl | null}
type ChangeView = {status: "main" | "loading" | "ready"; onlyChanged: boolean}

// Older drafts show as strips this wide, in pixels, each the left edge of a
// card tucked behind the next.
const STRIP = 40
const MAX_STRIPS = 4

/**
 * The checked-out draft as a card, with the drafts it was forked from tucked
 * behind it as strips, oldest leftmost. Clicking a strip checks that draft out.
 */
export function DraftStack(props: {
	element: Accessor<HTMLElement | undefined>
	lanes: Lane[]
	children: JSX.Element
}) {
	const strips = () => visibleStrips(props.lanes)
	const changes = useSubscription<ChangeView>(props.element, {type: "review:changes"})

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
			class="draft-stack"
			style={{
				"--draft-stack-strip": `${STRIP}px`,
				"--draft-stack-strips": strips().length,
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
