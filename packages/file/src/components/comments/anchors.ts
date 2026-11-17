// Comments on an image. Bytes can't be addressed, so what a thread is about
// (a pin, or a dragged region) is kept on the file doc itself, under
// `@anchors`, normalised to the image's natural box (0–1 on both axes; a pin
// has no width or height). The thread itself lives in the project's root doc
// and refers to its anchor by the sub-handle url
// `handle.sub("@anchors", id).url`. Replacing the file's bytes clears
// `@anchors`, which hides those threads.
//
// Plain functions, no DOM or framework, so the sidebar's ref-view can use them
// too.

import type {AutomergeUrl, DocHandle} from "@automerge/automerge-repo/slim"
import {refsByThread, type CommentEntry} from "./threads"

export type Anchor = {
	x: number
	y: number
	w: number
	h: number
	/**
	 * The bytes the anchor was placed on (`contentFingerprint`). Bytes
	 * replaced by something that doesn't clear `@anchors` (e.g. a sync from
	 * disk) leave the anchor behind; this tells it no longer applies.
	 */
	fingerprint?: string
}

export type DocWithAnchors = {
	content?: unknown
	"@anchors"?: Record<string, Anchor>
}

export type Point = {x: number; y: number}
export type Box = {width: number; height: number}
export type Rect = {left: number; top: number; width: number; height: number}

/** A press that moves less than this (in CSS px) drops a pin. */
export const DRAG_THRESHOLD = 4

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const round = (n: number) => Math.round(n * 10000) / 10000

/**
 * The anchor for a press at `start` released at `end`, both in px relative to
 * the drawn image's top-left, with the drawn image `box` big. A short press is
 * a pin; a drag is the region it spans, whichever way it went. Clamped to the
 * image.
 */
export function normaliseAnchor(
	start: Point,
	end: Point,
	box: Box,
	threshold = DRAG_THRESHOLD,
): Anchor {
	const nx = (px: number) => (box.width > 0 ? clamp01(px / box.width) : 0)
	const ny = (px: number) => (box.height > 0 ? clamp01(px / box.height) : 0)
	if (Math.hypot(end.x - start.x, end.y - start.y) < threshold) {
		return {x: round(nx(start.x)), y: round(ny(start.y)), w: 0, h: 0}
	}
	const x0 = nx(Math.min(start.x, end.x))
	const y0 = ny(Math.min(start.y, end.y))
	const x1 = nx(Math.max(start.x, end.x))
	const y1 = ny(Math.max(start.y, end.y))
	return {
		x: round(x0),
		y: round(y0),
		w: round(x1 - x0),
		h: round(y1 - y0),
	}
}

export const isPin = (anchor: Anchor) => !(anchor.w > 0 && anchor.h > 0)

/**
 * Where an image of `natural` size is drawn inside a `box` with
 * `object-fit: contain` (or `scale-down`, which never scales up).
 */
export function containRect(
	box: Box,
	natural: Box,
	fit: "contain" | "scale-down" = "contain",
): Rect {
	if (!(natural.width > 0 && natural.height > 0)) {
		return {left: 0, top: 0, width: box.width, height: box.height}
	}
	let scale = Math.min(box.width / natural.width, box.height / natural.height)
	if (fit === "scale-down") scale = Math.min(scale, 1)
	const width = natural.width * scale
	const height = natural.height * scale
	return {
		left: (box.width - width) / 2,
		top: (box.height - height) / 2,
		width,
		height,
	}
}

/**
 * A cheap fingerprint of a file's bytes: its length and a hash of up to 4096
 * evenly spread samples. Enough to tell a replaced image from the same one.
 */
export function contentFingerprint(content: unknown): string | undefined {
	if (!(content instanceof Uint8Array)) return undefined
	const n = content.length
	const step = Math.max(1, Math.floor(n / 4096))
	let hash = 0x811c9dc5
	for (let i = 0; i < n; i += step) {
		hash ^= content[i]
		hash = Math.imul(hash, 0x01000193)
	}
	return `${n}:${(hash >>> 0).toString(36)}`
}

/** Whether `anchor` (if any) still applies to the file's current bytes. */
export const anchorIsCurrent = (
	anchor: Anchor | undefined | null,
	fingerprint: string | undefined,
): anchor is Anchor =>
	!!anchor &&
	typeof anchor.x === "number" &&
	typeof anchor.y === "number" &&
	(anchor.fingerprint === undefined || anchor.fingerprint === fingerprint)

export const anchorUrl = (handle: DocHandle<any>, anchorId: string): AutomergeUrl =>
	handle.sub("@anchors", anchorId).url

/**
 * Put `anchor` on the file, stamped with the bytes it was placed on, and
 * return the ref a thread on it uses.
 */
export function addAnchor(
	handle: DocHandle<any>,
	anchor: Omit<Anchor, "fingerprint">,
): AutomergeUrl {
	const anchorId = crypto.randomUUID()
	const fingerprint = contentFingerprint(handle.doc()?.content)
	handle.change((doc: DocWithAnchors) => {
		doc["@anchors"] ??= {}
		doc["@anchors"][anchorId] = fingerprint ? {...anchor, fingerprint} : {...anchor}
	})
	return anchorUrl(handle, anchorId)
}

/** Take an anchor (by its ref) back off the file. */
export function removeAnchor(handle: DocHandle<any>, ref: AutomergeUrl): void {
	const id = Object.keys(handle.doc()?.["@anchors"] ?? {}).find(
		(id) => anchorUrl(handle, id) === ref,
	)
	if (!id) return
	handle.change((doc: DocWithAnchors) => {
		delete doc["@anchors"]?.[id]
	})
}

export type AnchoredThread = {
	threadUrl: AutomergeUrl
	/** the thread's refs into this file */
	refs: AutomergeUrl[]
	anchorId: string
	anchor: Anchor
	/** 1-based, in thread order, for the number drawn on it */
	index: number
}

/**
 * The threads (from the `patchwork:comments` subscription's `entries`, which
 * lists the unresolved ones) on an anchor that still applies to the image,
 * each with (the first of) its anchors. `doc` is the file doc (or a copy of
 * it).
 */
export function anchoredThreads(
	doc: DocWithAnchors | undefined,
	handle: DocHandle<any>,
	entries: CommentEntry[],
): AnchoredThread[] {
	const anchors = doc?.["@anchors"] ?? {}
	const fingerprint = contentFingerprint(doc?.content)
	const idByUrl = new Map<string, string>()
	for (const id of Object.keys(anchors)) {
		if (anchorIsCurrent(anchors[id], fingerprint)) idByUrl.set(anchorUrl(handle, id), id)
	}
	const out: AnchoredThread[] = []
	for (const [threadUrl, refs] of refsByThread(entries)) {
		const anchorId = refs.map((ref) => idByUrl.get(ref)).find((id) => id)
		if (!anchorId) continue
		out.push({threadUrl, refs, anchorId, anchor: anchors[anchorId], index: out.length + 1})
	}
	return out
}

/**
 * Replace a file's bytes, clearing its image anchors in the same change so
 * the threads on them are hidden rather than pointing at the wrong spot.
 */
export function replaceFileContent(
	handle: DocHandle<any>,
	content: Uint8Array | string,
	mimeType?: string,
): void {
	handle.change((doc: DocWithAnchors & {mimeType?: string}) => {
		doc.content = content
		if (mimeType) doc.mimeType = mimeType
		delete doc["@anchors"]
	})
}

/** Text of a quote of `text`: whitespace collapsed, at most `max` characters. */
export function quote(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim()
	const body = flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat
	return `“${body}”`
}
