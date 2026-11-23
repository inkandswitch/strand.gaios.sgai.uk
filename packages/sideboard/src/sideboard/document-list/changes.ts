import {
	parseAutomergeUrl,
	type AutomergeUrl,
} from "@automerge/automerge-repo/slim"
import {request} from "@inkandswitch/patchwork-providers"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {createEffect, createMemo, createSignal, onCleanup} from "solid-js"

// How a member differs between the two versions compared: both have it and
// it `differs`, or only `ours` (A, the checked-out version) or `theirs` (B)
// has it. A folder takes the marks of what's beneath it.
//
// A merge compared with its target reads as what merging does to the
// target instead: `changed`, `added` or `removed`, and `conflict` for a
// member with conflicts no one has resolved, and the folders above it.
export type Mark =
	| "differs"
	| "ours"
	| "theirs"
	| "changed"
	| "added"
	| "removed"
	| "conflict"

const AS_MERGED: Record<"differs" | "ours" | "theirs", Mark> = {
	differs: "changed",
	ours: "added",
	theirs: "removed",
}

// A file or folder only B has, linked from `parent`.
export type Ghost = {
	url: AutomergeUrl
	name: string
	type: string | undefined
	folder: boolean
	parent: AutomergeUrl
}

/**
 * The checked-out version compared with another, as the rows read it: a
 * file that differs is marked with how, a folder with what's beneath it,
 * what only the other version has shows as ghosts, and everything else is
 * quieter, or, `collapsed`, folded away.
 */
export type ChangeMarks = {
	mark(url: AutomergeUrl): Mark | undefined
	comparing(): boolean
	/** the merge shown against its target, if it's one: a preview, or a pull request */
	merge(): {published: boolean} | undefined
	ghostsIn(folder: AutomergeUrl): Ghost[]
	/** while comparing, whether what's unchanged is folded away */
	collapsed(): boolean
	toggleCollapsed(): void
}

type Overlay = AutomergeUrl | null
type Comparison =
	| {kind: "compare"; a: Overlay; b: Overlay}
	| {kind: "merge"; a: AutomergeUrl; b: Overlay; published: boolean}
	| null
type Member = {url: AutomergeUrl; heads: string[]; parent: AutomergeUrl | null}
type Link = {url?: unknown; name?: unknown; type?: unknown}
// The overlay provider's `merge:conflicts`, as this reads it.
type MergeConflicts = Record<AutomergeUrl, {state: string}[]>
// Where a version of a document lives, as the overlay provider answers
// `repo:handle-descriptor`.
type Descriptor = {url: AutomergeUrl; cloneUrl?: AutomergeUrl}
// The repo a view is handed: Patchwork's, over the page's base repo.
type ViewRepo = {
	baseRepo?: ViewRepo
	find(url: AutomergeUrl): Promise<{doc(): unknown}>
}

/**
 * What differs between the two versions compared, from each one's members:
 * a member with other heads differs, one only a version has is only there.
 */
export function useChangeMarks(
	element: HTMLElement & {repo?: unknown}
): ChangeMarks {
	const comparison = subscribe(
		element,
		{type: "compare"},
		null
	) as unknown as () => Comparison
	const [names, setNames] = createSignal(
		new Map<string, {name: string; type?: string}>()
	)
	const [collapsed, setCollapsed] = createSignal(false)

	// Each version's members, while two are compared.
	const members = createMemo(() => {
		const current = comparison()
		if (!current) return undefined
		const of = (overlay: Overlay) =>
			subscribe(element, {
				type: "overlay:members",
				overlay,
			} as never) as unknown as () => Member[] | undefined
		return {ours: of(current.a), theirs: of(current.b)}
	})

	const changes = createMemo(() => {
		const a = members()?.ours()
		const b = members()?.theirs()
		if (!a || !b) return undefined
		return compare(a, b)
	})

	// A ghost is named as its entry in the folder it's in, in B.
	createEffect(() => {
		const current = changes()
		const other = comparison()
		const repo = element.repo as ViewRepo | undefined
		if (!current || !other || !repo) return
		const base = repo.baseRepo ?? repo
		let live = true
		for (const ghost of current.onlyTheirs) {
			if (!ghost.parent || names().has(documentOf(ghost.url))) continue
			const parent = ghost.parent
			// B's version of the folder, from the overlay provider.
			request<Descriptor>(element, {
				type: "repo:handle-descriptor",
				url: `automerge:${documentOf(parent)}`,
				overlay: other.b,
			} as never)
				.then(answer => base.find(answer.cloneUrl ?? answer.url))
				.then(
					handle => {
						if (!live) return
						const docs =
							(handle.doc() as {docs?: Link[]} | undefined)?.docs ?? []
						const link = docs.find(
							each =>
								typeof each.url === "string" &&
								documentOf(each.url as AutomergeUrl) === documentOf(ghost.url)
						)
						if (!link) return
						setNames(previous =>
							new Map(previous).set(documentOf(ghost.url), {
								name: String(link.name ?? ""),
								type: typeof link.type === "string" ? link.type : undefined,
							})
						)
					},
					() => {}
				)
		}
		onCleanup(() => {
			live = false
		})
	})

	const ghosts = createMemo(() => {
		const byParent = new Map<string, Ghost[]>()
		const current = changes()
		if (!current) return byParent
		for (const member of current.onlyTheirs) {
			if (!member.parent) continue
			const named = names().get(documentOf(member.url))
			const ghost: Ghost = {
				url: member.url,
				name: named?.name ?? "",
				type: named?.type,
				folder: current.folders.has(documentOf(member.url)),
				parent: member.parent,
			}
			const key = documentOf(member.parent)
			byParent.set(key, [...(byParent.get(key) ?? []), ghost])
		}
		return byParent
	})

	// A merge (A) shown against its target (B), as the comparison says.
	const merge = createMemo(() => {
		const current = comparison()
		return current?.kind === "merge" ? {url: current.a, published: current.published} : undefined
	})
	const conflicts = createMemo(() => {
		const current = merge()
		return current
			? (subscribe(element, {type: "merge:conflicts", merge: current.url} as never) as unknown as () =>
					| MergeConflicts
					| undefined)
			: undefined
	})
	// The members with open conflicts, and the folders above them.
	const conflicted = createMemo(() => {
		const open = new Set<string>()
		const parents = new Map(
			(members()?.ours() ?? []).map(member => [documentOf(member.url), member.parent])
		)
		for (const [url, each] of Object.entries(conflicts()?.() ?? {})) {
			if (!each.some(conflict => conflict.state === "open")) continue
			let cursor: AutomergeUrl | null | undefined = url as AutomergeUrl
			while (cursor && !open.has(documentOf(cursor))) {
				open.add(documentOf(cursor))
				cursor = parents.get(documentOf(cursor))
			}
		}
		return open
	})

	const comparing = () => !!changes()
	return {
		mark: url => {
			if (conflicted().has(documentOf(url))) return "conflict"
			const mark = changes()?.marks.get(documentOf(url))
			return mark && merge() ? AS_MERGED[mark as keyof typeof AS_MERGED] : mark
		},
		merge: () => (merge() ? {published: merge()!.published} : undefined),
		comparing,
		ghostsIn: folder => ghosts().get(documentOf(folder)) ?? [],
		collapsed: () => comparing() && collapsed(),
		toggleCollapsed: () => setCollapsed(yn => !yn),
	}
}

/**
 * How `ours` and `theirs` differ, member by member, by document. A folder
 * (anything another member was reached from) is marked for what's beneath
 * it rather than for itself: one mark where everything beneath agrees,
 * `differs` where it doesn't.
 */
export function compare(ours: Member[], theirs: Member[]) {
	const byOurs = new Map(ours.map(member => [documentOf(member.url), member]))
	const byTheirs = new Map(
		theirs.map(member => [documentOf(member.url), member])
	)
	const folders = new Set<string>()
	for (const member of [...ours, ...theirs])
		if (member.parent) folders.add(documentOf(member.parent))

	const marks = new Map<string, Mark>()
	const beneath = new Map<string, Set<Mark>>()
	const markUp = (
		member: Member | undefined,
		mark: Mark,
		side: Map<string, Member>
	) => {
		const seen = new Set<string>()
		let parent = member?.parent
		while (parent && !seen.has(documentOf(parent))) {
			const id = documentOf(parent)
			seen.add(id)
			beneath.set(id, (beneath.get(id) ?? new Set()).add(mark))
			parent = side.get(id)?.parent ?? null
		}
	}
	for (const member of ours) {
		const id = documentOf(member.url)
		const other = byTheirs.get(id)
		const mark: Mark | undefined = !other
			? "ours"
			: sameHeads(member.heads, other.heads)
				? undefined
				: "differs"
		if (!mark) continue
		if (!folders.has(id)) marks.set(id, mark)
		markUp(member, mark, byOurs)
	}
	const onlyTheirs: Member[] = []
	for (const member of theirs) {
		const id = documentOf(member.url)
		if (byOurs.has(id)) continue
		onlyTheirs.push(member)
		if (!folders.has(id)) marks.set(id, "theirs")
		markUp(member, "theirs", byTheirs)
	}
	for (const [id, below] of beneath)
		marks.set(id, below.size === 1 ? [...below][0] : "differs")
	return {marks, folders, onlyTheirs}
}

function sameHeads(a: readonly string[], b: readonly string[]) {
	if (a.length !== b.length) return false
	const set = new Set(b)
	return a.every(head => set.has(head))
}

function documentOf(url: AutomergeUrl): string {
	return parseAutomergeUrl(url).documentId
}
