// Diff markers for a file opened on a draft: what the draft changed, against
// the file as it was when the draft forked off. Only shows inside a drafts
// provider (`draft:selection`), and only once the draft has written to the
// file.

import {createEffect, createSignal, on, onCleanup} from "solid-js"
import {
	parseAutomergeUrl,
	stringifyAutomergeUrl,
	type AutomergeUrl,
	type DocHandle,
	type Repo,
	type UrlHeads,
} from "@automerge/automerge-repo/slim"
import {Compartment} from "@codemirror/state"
import {EditorView} from "@codemirror/view"
import {getChunks, unifiedMergeView} from "@codemirror/merge"
import {subscribe} from "@inkandswitch/patchwork-providers-solid"
import {fileText} from "../datatype"
import type {FileDoc} from "../types"

// The parts of the drafts package's stored shapes read here.
type DraftSelection = {checkedOut: AutomergeUrl | null}
type CloneEntry = {clonedAt: UrlHeads; cloneUrl?: AutomergeUrl}
type DraftDoc = {clones?: Record<AutomergeUrl, CloneEntry>}

export function createDraftDiff(props: {
	handle: DocHandle<unknown>
	element: HTMLElement & {repo?: Repo}
}) {
	const compartment = new Compartment()
	const baseline = draftBaseline(props)

	const attach = (view: EditorView) => {
		let scrolled = false
		createEffect(
			on(baseline, (original) => {
				view.dispatch({
					effects: compartment.reconfigure(
						original === undefined
							? []
							: unifiedMergeView({
									original,
									mergeControls: false,
									syntaxHighlightDeletions: true,
								}),
					),
				})
				if (original === undefined || scrolled) return
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

// The file's text at the draft's fork point: undefined on main, outside a
// draft, and while the draft hasn't changed the file; empty for a file the
// draft created.
function draftBaseline(props: {
	handle: DocHandle<unknown>
	element: HTMLElement & {repo?: Repo}
}) {
	const [baseline, setBaseline] = createSignal<string | undefined>()
	const selection = subscribe<DraftSelection>(props.element, {
		type: "draft:selection",
	})
	const ownUrl = stringifyAutomergeUrl({documentId: props.handle.documentId})

	createEffect(() => {
		const draftUrl = selection()?.checkedOut
		const repo = props.element.repo
		if (!draftUrl || !repo) return setBaseline(undefined)
		let cancelled = false
		let draft: DocHandle<DraftDoc> | undefined
		const update = async () => {
			const entry = draft?.doc()?.clones?.[ownUrl]
			try {
				const text = await textAtFork(repo, entry)
				if (!cancelled) setBaseline(text)
			} catch (error) {
				console.warn("[file] couldn't read the draft's fork point", error)
			}
		}
		repo.find<DraftDoc>(draftUrl).then((handle) => {
			if (cancelled) return
			draft = handle
			handle.on("change", update)
			void update()
		})
		onCleanup(() => {
			cancelled = true
			draft?.off("change", update)
		})
	})

	return baseline
}

// The clone shares the original's history, so the fork point's heads name the
// same version in it.
async function textAtFork(
	repo: Repo,
	entry: CloneEntry | undefined,
): Promise<string | undefined> {
	if (!entry?.cloneUrl) return undefined
	if (entry.clonedAt.length === 0) return ""
	const {documentId} = parseAutomergeUrl(entry.cloneUrl)
	const atFork = await repo.find<FileDoc>(
		stringifyAutomergeUrl({documentId, heads: entry.clonedAt}),
	)
	return fileText(atFork.doc())
}
