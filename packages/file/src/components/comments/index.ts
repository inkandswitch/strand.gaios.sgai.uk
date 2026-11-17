// Comments on a text file's content: select some text, hit "Comment", and the
// frame starts a thread on that range (in the project's root doc) and opens
// it in the Comments sidebar. Commented ranges are highlighted (more strongly
// when they're focused from the sidebar), clicking one opens its thread in the
// sidebar, and the editor's selection is written to `patchwork:focus` so the
// sidebar can follow it along. Adapted from codemirror-base's tool.tsx.

import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	onCleanup,
} from "solid-js"
import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import {
	EditorSelection,
	RangeSet,
	StateEffect,
	StateField,
	type Extension,
} from "@codemirror/state"
import {Decoration, EditorView, type DecorationSet} from "@codemirror/view"
import {subscribe, subscribeDoc} from "@inkandswitch/patchwork-providers-solid"
import {commentUI} from "./commentUI"
import {
	commentRanges,
	createThread,
	rangeRef,
	refsByThread,
	showComments,
	type CommentEntry,
} from "./threads"

const PATH = ["content"]

type Focus = {
	selection: Record<AutomergeUrl, true>
	highlight: Record<AutomergeUrl, true>
}

// Returns the extension to put in the editor, and `attach`, to call with the
// view once it exists so the highlights can be kept up to date. Call it from
// a component, since it subscribes for as long as that's mounted.
export function createFileComments(props: {
	handle: DocHandle<any>
	element: HTMLElement & {repo?: Repo}
}) {
	const {handle, element} = props

	// Ranges are automerge cursors, which only exist on real text, so an
	// ImmutableString file can't be commented on.
	const isText = () => typeof handle.doc()?.content === "string"
	const canComment = () => isText() && !handle.isReadOnly()

	const entries = subscribe<CommentEntry[]>(
		element,
		{type: "patchwork:comments", url: handle.url},
		[],
	)
	const [focusDoc, focusHandle] = subscribeDoc<Focus>(element, {
		type: "patchwork:focus",
	})

	const [targets] = createResource(
		entries,
		(entries) => findAll(element.repo, entries.map((e) => e.targetUrl)),
		{initialValue: []},
	)

	// What the sidebar has focused: the editor's own selection (written below)
	// and whatever thread the pointer is over or was clicked on.
	const focusUrls = createMemo(() => {
		const doc = focusDoc()
		return [
			...Object.keys(doc?.selection ?? {}),
			...Object.keys(doc?.highlight ?? {}),
		].filter((url) => url.startsWith(handle.url)) as AutomergeUrl[]
	})
	const [focused] = createResource(
		focusUrls,
		(urls) => findAll(element.repo, urls),
		{initialValue: []},
	)

	// The last selection the editor wrote to focus, so it isn't revealed back.
	let lastSelectionUrl: AutomergeUrl | undefined

	// The selection to reveal: what's selected in this file, unless it's what
	// the editor itself just wrote.
	const revealUrls = createMemo(
		() => {
			const urls = Object.keys(focusDoc()?.selection ?? {}).filter((url) =>
				url.startsWith(handle.url),
			) as AutomergeUrl[]
			if (urls.length === 1 && urls[0] === lastSelectionUrl) return []
			return urls
		},
		[],
		{equals: (a, b) => a.length === b.length && a.every((url, i) => url === b[i])},
	)
	const [revealed] = createResource(
		revealUrls,
		(urls) => findAll(element.repo, urls),
		{initialValue: []},
	)

	// Bumped after every change to the file, since that can move the ranges.
	// Deferred so the editor has taken the same change first.
	const [revision, setRevision] = createSignal(0)
	const bump = () => queueMicrotask(() => setRevision((n) => n + 1))
	handle.on("change", bump)
	onCleanup(() => handle.off("change", bump))

	const threadAtPos = (pos: number) => {
		const threadByTarget = new Map(
			entries().map((e) => [e.targetUrl, e.threadUrl]),
		)
		for (const target of targets()) {
			const range = target.rangePositions()
			if (!range || range[0] === range[1]) continue
			if (pos < range[0] || pos > range[1]) continue
			const threadUrl = threadByTarget.get(target.url)
			if (threadUrl) return threadUrl
		}
		return null
	}

	const selectRefs = (refs: AutomergeUrl[]) =>
		focusHandle()?.change((doc) => {
			doc.selection = Object.fromEntries(refs.map((r) => [r, true as const]))
		})

	const createThreadForRange = async (from: number, to: number) => {
		if (!canComment()) return
		const ref = rangeRef(handle, PATH, from, to)
		const threadUrl = await createThread(element, [ref])
		if (threadUrl) selectRefs([ref])
	}

	// Focus the thread's ranges and open it in the sidebar.
	const openThreadAtPos = (pos: number) => {
		const threadUrl = threadAtPos(pos)
		if (!threadUrl) return
		selectRefs(refsByThread(entries()).get(threadUrl) ?? [])
		showComments(element, threadUrl)
	}

	const followSelection = EditorView.updateListener.of((update) => {
		const focus = focusHandle()
		if (!update.selectionSet || !focus || !isText()) return
		const {from, to} = update.state.selection.main
		const url = rangeRef(handle, PATH, from, to)
		if (url === lastSelectionUrl) return
		lastSelectionUrl = url
		focus.change((doc) => {
			doc.selection = {[url]: true}
		})
	})

	const extension: Extension = [
		highlights,
		highlightTheme,
		followSelection,
		commentUI({
			createThreadForRange,
			openThreadAtPos,
			canComment,
		}),
	]

	const attach = (view: EditorView) => {
		createEffect(() => {
			revision()
			view.dispatch({
				effects: setHighlights.of(
					buildHighlights(targets(), focused(), view.state.doc.length),
				),
			})
		})

		// Bring a range selected elsewhere (a thread card clicked in the
		// sidebar, or a doc opened to show one) into view, if it isn't already.
		// Not the editor's own selection, nor what the sidebar merely hovers.
		createEffect(() => {
			const ranges = commentRanges(revealed())
			if (!ranges.length) return
			const length = view.state.doc.length
			const from = Math.min(Math.min(...ranges.map((r) => r[0])), length)
			const to = Math.min(Math.max(...ranges.map((r) => r[1])), length)
			view.dispatch({
				effects: EditorView.scrollIntoView(EditorSelection.range(from, to), {
					x: "nearest",
					y: "nearest",
				}),
			})
		})
	}

	return {extension, attach}
}

const findAll = async (
	repo: Repo | undefined,
	urls: AutomergeUrl[],
): Promise<DocHandle<unknown>[]> => {
	if (!repo) return []
	const unique = [...new Set(urls)]
	const found = await Promise.allSettled(unique.map((url) => repo.find(url)))
	return found.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
}

const setHighlights = StateEffect.define<DecorationSet>()

const highlights = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setHighlights)) return effect.value
		}
		return tr.docChanged ? value.map(tr.changes) : value
	},
	provide: (field) => EditorView.decorations.from(field),
})

const plain = Decoration.mark({class: "cm-comment-target"})
const emphasised = Decoration.mark({
	class: "cm-comment-target cm-comment-target-focused",
})

// Commented ranges, tinted more strongly where they overlap what's focused.
// Clamped to the editor's text, which can briefly lag the file.
export function buildHighlights(
	targets: DocHandle<unknown>[],
	focused: DocHandle<unknown>[],
	length: number,
): DecorationSet {
	const marks = []
	for (const target of targets) {
		const range = target.rangePositions()
		if (!range) continue
		const from = Math.min(range[0], length)
		const to = Math.min(range[1], length)
		if (from === to) continue
		const isFocused = focused.some((f) => f.overlaps(target))
		marks.push((isFocused ? emphasised : plain).range(from, to))
	}
	return RangeSet.of(marks, true)
}

// A light yellow highlighter over the editor's surface, leaving the text in
// the editor's own ink so it reads in light and dark themes alike.
const highlightTheme = EditorView.baseTheme({
	".cm-comment-target": {
		borderBottom: "2px solid var(--comment-mark, #f2c94c)",
		backgroundColor:
			"var(--comment-highlight, color-mix(in oklch, #ffd84d 30%, var(--text-editor-fill, white)))",
	},
	".cm-comment-target-focused": {
		backgroundColor:
			"var(--comment-highlight-focused, color-mix(in oklch, #ffd84d 62%, var(--text-editor-fill, white)))",
	},
})
