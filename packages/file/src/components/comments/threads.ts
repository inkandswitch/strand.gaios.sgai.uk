// Comment threads live in the project's root document, not on the file: the
// frame creates them (`comments:create`) and the comments provider says which
// ones point into a file (`patchwork:comments`). A tool only makes the refs
// (what a thread is about) and asks for a thread on them.

import {
	cursor,
	type AutomergeUrl,
	type DocHandle,
} from "@automerge/automerge-repo/slim"
import {request} from "@inkandswitch/patchwork-providers"

/** One entry of the `patchwork:comments` subscription. */
export type CommentEntry = {targetUrl: AutomergeUrl; threadUrl: AutomergeUrl}

/**
 * Ask the frame for a thread on `refs`, holding one draft comment by the
 * current contact. It opens the comments sidebar on it. Resolves to the
 * thread's url, or null if it couldn't make one.
 */
export const createThread = (
	element: HTMLElement,
	refs: AutomergeUrl[],
): Promise<AutomergeUrl | null> =>
	request<AutomergeUrl | null>(element, {type: "comments:create", refs})

/** Open the comments sidebar on an existing thread. */
export const showComments = (element: HTMLElement, threadUrl: AutomergeUrl) =>
	element.dispatchEvent(
		new CustomEvent("patchwork:show-comments", {
			bubbles: true,
			composed: true,
			detail: {threadUrl},
		}),
	)

/**
 * The ref for [from, to] of the text at `path`: a pair of automerge cursors,
 * so it follows the text as it's edited. Only works on real text: on anything
 * else (an ImmutableString, bytes) it throws.
 */
export const rangeRef = (
	handle: DocHandle<any>,
	path: readonly string[],
	from: number,
	to: number,
): AutomergeUrl => handle.sub(...path, cursor(from, to)).url

/** Each thread's refs into this doc, from the subscription's entries, in order. */
export function refsByThread(
	entries: CommentEntry[],
): Map<AutomergeUrl, AutomergeUrl[]> {
	const out = new Map<AutomergeUrl, AutomergeUrl[]>()
	for (const {targetUrl, threadUrl} of entries) {
		const refs = out.get(threadUrl)
		if (!refs) out.set(threadUrl, [targetUrl])
		else if (!refs.includes(targetUrl)) refs.push(targetUrl)
	}
	return out
}

// Where each target range sits in the text right now, leaving out any whose
// text has been deleted out from under it.
export const commentRanges = (
	targets: DocHandle<unknown>[],
): [number, number][] => {
	const ranges: [number, number][] = []
	for (const target of targets) {
		const positions = target.rangePositions()
		if (!positions || positions[0] === positions[1]) continue
		ranges.push(positions)
	}
	return ranges
}
