// Inline diff markers for a text file, in the "inline" compare mode: what
// changed against the version the panel showing the file compares it with.
// Only shows inside something answering `compare:view`, like the GAIOS dock
// on a draft that changed the file.

import {createEffect, createSignal, on, onCleanup} from "solid-js"
import type {AutomergeUrl, Repo} from "@automerge/automerge-repo/slim"
import {Compartment} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {getChunks, unifiedMergeView} from "@codemirror/merge"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"

// The compare view the dock answers with, as this reads it.
type CompareView = {
	base: AutomergeUrl | null
	created: boolean
	mode: string | null
	options: {collapsed?: boolean} | null
}

type Inline = {original: string; collapsed: boolean}

export function createDraftDiff(props: {element: HTMLElement & {repo?: Repo}}) {
	const compartment = new Compartment()
	const inline = inlineDiff(props)

	const attach = (view: EditorView) => {
		let scrolled = false
		createEffect(
			on(inline, current => {
				view.dispatch({
					effects: compartment.reconfigure(
						current === undefined
							? []
							: unifiedMergeView({
									original: current.original,
									mergeControls: false,
									syntaxHighlightDeletions: true,
									collapseUnchanged: current.collapsed
										? {margin: 3, minSize: 4}
										: undefined,
								}),
					),
				})
				if (current === undefined || scrolled) return
				scrolled = true
				const first = getChunks(view.state)?.chunks[0]
				if (!first) return
				view.dispatch({
					effects: EditorView.scrollIntoView(first.fromB, {y: "center"}),
				})
			}),
		)
	}

	return {extension: compartment.of([]), attach}
}

// The text to show changes against, and whether to fold what didn't change:
// undefined outside the inline mode; an empty original for a file the draft
// created.
function inlineDiff(props: {element: HTMLElement & {repo?: Repo}}) {
	const [inline, setInline] = createSignal<Inline | undefined>(undefined, {
		equals: (a, b) => a?.original === b?.original && a?.collapsed === b?.collapsed,
	})
	const compare = subscribe<CompareView>(props.element, {
		type: "compare:view",
		modes: {inline: true},
	})

	createEffect(() => {
		const view = compare()
		const repo = props.element.repo
		if (view?.mode !== "inline" || !repo) return setInline(undefined)
		const collapsed = !!view.options?.collapsed
		if (view.created) return setInline({original: "", collapsed})
		if (!view.base) return setInline(undefined)
		let cancelled = false
		repo.find<FileDoc>(view.base).then(
			handle => {
				if (!cancelled) setInline({original: fileText(handle.doc()), collapsed})
			},
			error => console.warn("[file] couldn't read the version compared against", error),
		)
		onCleanup(() => {
			cancelled = true
		})
	})

	return inline
}
