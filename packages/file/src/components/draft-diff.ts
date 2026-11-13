// Inline diff markers for a text file, in the "inline" and "changes only"
// compare modes: what differs from the other draft's version of the file,
// which the panel showing it compares it with. Only shows inside something
// answering `compare:view`, like the GAIOS dock while the checked-out draft is
// compared with another.

import {createEffect, createMemo, on} from "solid-js"
import {Automerge} from "@automerge/automerge-repo/slim"
import {Compartment} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {getChunks, unifiedMergeView} from "@codemirror/merge"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"

// The compare view the dock answers with, as this reads it.
type CompareView = {
	mode: string | null
	options: unknown
	other: Uint8Array | null
	missing: boolean
}

type Inline = {original: string; collapsed: boolean}

const MODES = ["inline", "changes-only"]

export function createDraftDiff(props: {element: HTMLElement}) {
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
// undefined outside the two modes; empty when the other draft doesn't have
// the file.
function inlineDiff(props: {element: HTMLElement}) {
	const compare = subscribe(props.element, {
		type: "compare:view",
		modes: {inline: true, "changes-only": true},
		prefers: "inline",
	})
	return createMemo<Inline | undefined>(
		() => {
			const view = compare() as unknown as CompareView | undefined
			if (!view?.mode || !MODES.includes(view.mode)) return undefined
			const collapsed = view.mode === "changes-only"
			if (view.missing) return {original: "", collapsed}
			if (!view.other) return undefined
			try {
				return {original: fileText(Automerge.load<FileDoc>(view.other)), collapsed}
			} catch (error) {
				console.warn("[file] couldn't read the version compared with", error)
				return undefined
			}
		},
		undefined,
		{equals: (a, b) => a?.original === b?.original && a?.collapsed === b?.collapsed},
	)
}
