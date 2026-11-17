// What a comment's ref points at in a file, for the comments sidebar's thread
// cards (`patchwork:ref-view`): an image anchor (pin or region) or a range of
// the text. Loaded into the sidebar, so it's plain DOM and kept small.

import type {DocHandle} from "@automerge/automerge-repo/slim"
import {
	anchorIsCurrent,
	contentFingerprint,
	isPin,
	quote,
	type Anchor,
} from "./components/comments/anchors"
import {createBinaryUrl} from "./utils"

const ACCENT = "#f2c94c"

const isAnchorRef = (ref: DocHandle<unknown>) => ref.path[0]?.prop === "@anchors"

// The anchors among `refs` that still apply to the file's current bytes.
const currentAnchors = (refs: DocHandle<unknown>[], doc: DocHandle<unknown>) => {
	const fingerprint = contentFingerprint((doc.doc() as {content?: unknown})?.content)
	return refs
		.filter(isAnchorRef)
		.map((ref) => ref.doc() as Anchor | undefined)
		.filter((anchor): anchor is Anchor => anchorIsCurrent(anchor, fingerprint))
}

export function describe(
	refs: DocHandle<unknown>[],
	doc: DocHandle<unknown>,
): string | null | false {
	if (refs.some(isAnchorRef)) {
		const anchors = currentAnchors(refs, doc)
		// Cleared, or left behind by a replaced file: the thread is moot.
		if (anchors.length === 0) return false
		// The thumbnail shows where: no words needed.
		return ""
	}

	for (const ref of refs) {
		if (!ref.range) continue
		const positions = ref.rangePositions()
		if (!positions || positions[0] === positions[1]) continue
		const text = ref.doc()
		if (typeof text !== "string") continue
		return quote(text)
	}
	return null
}

export function thumbnail(
	refs: DocHandle<unknown>[],
	doc: DocHandle<unknown>,
	element: HTMLElement,
): () => void {
	const anchor = currentAnchors(refs, doc)[0]
	const file = doc.doc() as {content?: unknown; mimeType?: string} | undefined
	const url =
		anchor && file?.content instanceof Uint8Array
			? createBinaryUrl(file.content, file.mimeType)
			: undefined
	if (!anchor || !url) return () => {}

	const canvas = document.createElement("canvas")
	canvas.style.display = "block"
	canvas.style.width = "100%"
	canvas.style.height = "100%"
	element.append(canvas)

	let cancelled = false
	const image = new Image()
	image.onload = () => {
		if (cancelled) return
		const accent =
			getComputedStyle(element).getPropertyValue("--comment-mark").trim() ||
			ACCENT
		draw(canvas, image, anchor, element, accent)
	}
	image.src = url

	return () => {
		cancelled = true
		image.onload = null
		URL.revokeObjectURL(url)
		canvas.remove()
	}
}

/**
 * The part of the image to show for `anchor`, in natural px: the region with
 * some room around it, or a square around the pin, widened to the box's
 * aspect ratio and kept inside the image.
 */
export function cropFor(
	anchor: Anchor,
	natural: {width: number; height: number},
	aspect: number,
): {x: number; y: number; width: number; height: number} {
	const W = natural.width
	const H = natural.height
	const cx = (anchor.x + anchor.w / 2) * W
	const cy = (anchor.y + anchor.h / 2) * H
	let width: number
	let height: number
	if (isPin(anchor)) {
		height = Math.min(W, H) * 0.35
		width = height * aspect
	} else {
		width = anchor.w * W * 1.4
		height = anchor.h * H * 1.4
		if (width / height < aspect) width = height * aspect
		else height = width / aspect
	}
	// Never more than the whole image.
	const fit = Math.min(1, W / width, H / height)
	width *= fit
	height *= fit
	const x = Math.min(Math.max(cx - width / 2, 0), W - width)
	const y = Math.min(Math.max(cy - height / 2, 0), H - height)
	return {x, y, width, height}
}

function draw(
	canvas: HTMLCanvasElement,
	image: HTMLImageElement,
	anchor: Anchor,
	element: HTMLElement,
	accent: string,
) {
	const boxW = element.clientWidth || 44
	const boxH = element.clientHeight || 28
	const ratio = window.devicePixelRatio || 1
	canvas.width = Math.round(boxW * ratio)
	canvas.height = Math.round(boxH * ratio)
	const ctx = canvas.getContext("2d")
	if (!ctx) return
	ctx.scale(ratio, ratio)

	const natural = {width: image.naturalWidth, height: image.naturalHeight}
	if (!natural.width || !natural.height) return
	const crop = cropFor(anchor, natural, boxW / boxH)
	const scale = Math.min(boxW / crop.width, boxH / crop.height)
	const dx = (boxW - crop.width * scale) / 2
	const dy = (boxH - crop.height * scale) / 2
	ctx.drawImage(
		image,
		crop.x,
		crop.y,
		crop.width,
		crop.height,
		dx,
		dy,
		crop.width * scale,
		crop.height * scale,
	)

	// natural px → box px
	const bx = (px: number) => dx + (px - crop.x) * scale
	const by = (px: number) => dy + (px - crop.y) * scale
	ctx.strokeStyle = accent
	ctx.lineWidth = 1.5
	if (isPin(anchor)) {
		ctx.setLineDash([1.5, 2])
		ctx.beginPath()
		ctx.arc(bx(anchor.x * natural.width), by(anchor.y * natural.height), 5, 0, Math.PI * 2)
		ctx.fillStyle = accent
		ctx.globalAlpha = 0.25
		ctx.fill()
		ctx.globalAlpha = 1
		ctx.stroke()
	} else {
		ctx.setLineDash([3, 2])
		const x = bx(anchor.x * natural.width)
		const y = by(anchor.y * natural.height)
		ctx.strokeRect(x, y, anchor.w * natural.width * scale, anchor.h * natural.height * scale)
	}
}

export default {describe, thumbnail}
