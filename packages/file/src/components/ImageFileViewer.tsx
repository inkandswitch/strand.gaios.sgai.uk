import {
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js"
import type {AutomergeUrl, DocHandle} from "@automerge/automerge-repo/slim"
import {subscribe, subscribeDoc} from "@inkandswitch/patchwork-providers-solid"
import type {FileDoc} from "../types"
import {createBinaryUrl} from "../utils"
import {isBinaryFileDoc} from "../datatype"
import {
	addAnchor,
	anchoredThreads,
	containRect,
	isPin,
	normaliseAnchor,
	type Anchor,
	type DocWithAnchors,
	type Point,
	type Rect,
	removeAnchor,
} from "./comments/anchors"
import {createThread, showComments, type CommentEntry} from "./comments/threads"

export type ImageFileDoc = FileDoc & {
	extension: "svg" | "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
}

type Focus = {
	selection: Record<AutomergeUrl, true>
	highlight: Record<AutomergeUrl, true>
}

export function ImageFileViewer(props: {
	doc: FileDoc
	element?: HTMLElement
	/** the file's handle; without one (or read-only) there's no commenting */
	handle?: DocHandle<any>
}) {
	// Two versions of an image line up laid over each other: the panel
	// showing it can fade or swipe between them.
	const compare = props.element
		? subscribe<any>(props.element, {
				type: "compare:view",
				modes: {"onion-skin": true, swipe: true},
				prefers: "swipe",
			})
		: () => undefined

	const imgUrl = createMemo(() => {
		if (isBinaryFileDoc(props.doc)) {
			return createBinaryUrl(props.doc.content, props.doc.mimeType)
		}
		return undefined
	})
	createMemo((previous?: string) => {
		const url = imgUrl()
		if (previous && previous !== url) URL.revokeObjectURL(previous)
		return url
	})
	onCleanup(() => {
		const url = imgUrl()
		if (url) URL.revokeObjectURL(url)
	})

	return (
		<Show
			when={imgUrl()}
			fallback={
				<div
					style={{
						background: "var(--editor-fill)",
						color: "var(--editor-line)",
					}}>
					No image to display
				</div>
			}>
			{(src) => (
				<div class="file-image">
					<ImageWithAnchors
						src={src()}
						alt={props.doc.name}
						doc={props.doc as DocWithAnchors}
						element={props.element}
						handle={props.handle}
						// While compared, the anchors are still drawn (each version's
						// view lays them over its own picture), but new ones aren't made.
						comparing={!!compare()?.mode}
					/>
				</div>
			)}
		</Show>
	)
}

function ImageWithAnchors(props: {
	src: string
	alt: string
	doc: DocWithAnchors
	element?: HTMLElement
	handle?: DocHandle<any>
	comparing: boolean
}) {
	ensureStyles()
	let img!: HTMLImageElement
	let overlay!: HTMLDivElement

	// Where the picture is actually drawn inside the <img> box (object-fit:
	// contain), relative to the wrapper. The overlay sits exactly over it, so
	// anchors placed in % of it line up at any size.
	const [rect, setRect] = createSignal<Rect | null>(null)
	const measure = () => {
		if (!img?.naturalWidth) return setRect(null)
		const inner = containRect(
			{width: img.clientWidth, height: img.clientHeight},
			{width: img.naturalWidth, height: img.naturalHeight},
		)
		setRect({
			left: img.offsetLeft + img.clientLeft + inner.left,
			top: img.offsetTop + img.clientTop + inner.top,
			width: inner.width,
			height: inner.height,
		})
	}
	onMount(() => {
		const observer = new ResizeObserver(measure)
		observer.observe(img)
		img.addEventListener("load", measure)
		measure()
		onCleanup(() => {
			observer.disconnect()
			img.removeEventListener("load", measure)
		})
	})

	const element = props.element
	const [focusDoc, focusHandle] = element
		? subscribeDoc<Focus>(element, {type: "patchwork:focus"})
		: [() => undefined, () => undefined]
	// The unresolved threads pointing into this file (they live in the
	// project's root doc).
	const entries = (() => {
		const handle = props.handle
		return element && handle
			? subscribe<CommentEntry[]>(element, {type: "patchwork:comments", url: handle.url}, [])
			: () => [] as CommentEntry[]
	})()

	const canComment = () =>
		!!props.handle && !props.handle.isReadOnly() && !props.comparing

	const threads = createMemo(() =>
		props.handle ? anchoredThreads(props.doc, props.handle, entries() ?? []) : [],
	)

	const focused = createMemo(() => {
		const doc = focusDoc()
		return new Set([
			...Object.keys(doc?.selection ?? {}),
			...Object.keys(doc?.highlight ?? {}),
		])
	})

	const select = (refs: AutomergeUrl[]) => {
		const focus = focusHandle()
		if (!focus) return
		const current = Object.keys(focus.doc()?.selection ?? {})
		if (current.length === refs.length && refs.every((r) => current.includes(r))) {
			return
		}
		focus.change((doc) => {
			doc.selection = Object.fromEntries(refs.map((r) => [r, true as const]))
		})
	}

	// A click on the picture itself lets go of a thread selected here.
	const onImageClick = () => {
		const handle = props.handle
		if (!handle) return
		const selection = Object.keys(focusDoc()?.selection ?? {})
		if (selection.some((url) => url.startsWith(handle.url))) select([])
	}

	// Comment mode: a click drops a pin, a drag draws a region.
	const [commenting, setCommenting] = createSignal(false)
	const [draft, setDraft] = createSignal<Anchor | null>(null)
	let start: Point | null = null

	const pointAt = (event: PointerEvent): Point => {
		const box = overlay.getBoundingClientRect()
		return {x: event.clientX - box.left, y: event.clientY - box.top}
	}
	const box = () => {
		const r = overlay.getBoundingClientRect()
		return {width: r.width, height: r.height}
	}

	const onPointerDown = (event: PointerEvent) => {
		if (!commenting() || event.button !== 0) return
		if ((event.target as HTMLElement).closest("button")) return
		event.preventDefault()
		overlay.setPointerCapture(event.pointerId)
		start = pointAt(event)
		setDraft(normaliseAnchor(start, start, box()))
	}
	const onPointerMove = (event: PointerEvent) => {
		if (!start) return
		setDraft(normaliseAnchor(start, pointAt(event), box()))
	}
	const onPointerUp = (event: PointerEvent) => {
		if (!start) return
		const anchor = normaliseAnchor(start, pointAt(event), box())
		start = null
		setDraft(null)
		create(anchor)
	}
	const onPointerCancel = () => {
		start = null
		setDraft(null)
	}

	const create = async (anchor: Anchor) => {
		const handle = props.handle
		if (!handle || !element || !canComment()) return
		setCommenting(false)
		const ref = addAnchor(handle, anchor)
		const threadUrl = await createThread(element, [ref])
		// No thread to hang it on: don't leave the anchor behind.
		if (!threadUrl) return removeAnchor(handle, ref)
		select([ref])
	}

	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && commenting()) {
			onPointerCancel()
			setCommenting(false)
		}
	}
	window.addEventListener("keydown", onKeyDown)
	onCleanup(() => window.removeEventListener("keydown", onKeyDown))

	const pct = (n: number) => `${n * 100}%`

	return (
		<>
			<img
				ref={img}
				src={props.src}
				alt={props.alt}
				onClick={onImageClick}
				style={{
					"max-width": "100%",
					"max-height": "100%",
					"object-fit": "contain",
				}}
			/>
			<Show when={rect() && (canComment() || threads().length > 0)}>
				<div
					ref={overlay}
					class="file-image__overlay"
					classList={{"file-image__overlay--commenting": commenting()}}
					style={{
						left: `${rect()!.left}px`,
						top: `${rect()!.top}px`,
						width: `${rect()!.width}px`,
						height: `${rect()!.height}px`,
					}}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerCancel}>
					<For each={threads()}>
						{(entry) => {
							const anchor = () => entry.anchor
							const isFocused = () =>
								entry.refs.some((ref) => focused().has(ref))
							return (
								<div
									class="file-image__anchor"
									classList={{
										"file-image__anchor--pin": isPin(anchor()),
										"file-image__anchor--region": !isPin(anchor()),
										"file-image__anchor--focused": isFocused(),
									}}
									title="Comment"
									style={{
										left: pct(anchor().x),
										top: pct(anchor().y),
										...(isPin(anchor())
											? {}
											: {width: pct(anchor().w), height: pct(anchor().h)}),
									}}
									onClick={(event) => {
										event.stopPropagation()
										select(entry.refs)
										if (element) showComments(element, entry.threadUrl)
									}}
								/>
							)
						}}
					</For>
					<Show when={draft()}>
						{(anchor) => (
							<div
								class="file-image__draft"
								classList={{"file-image__draft--pin": isPin(anchor())}}
								style={{
									left: pct(anchor().x),
									top: pct(anchor().y),
									width: pct(anchor().w),
									height: pct(anchor().h),
								}}
							/>
						)}
					</Show>
					<Show when={canComment()}>
						<button
							type="button"
							class="file-image__comment-button"
							classList={{"file-image__comment-button--active": commenting()}}
							aria-pressed={commenting()}
							onClick={() => {
								onPointerCancel()
								setCommenting(!commenting())
							}}>
							{COMMENT_ICON}
							<span>Comment</span>
						</button>
					</Show>
					<Show when={commenting()}>
						<div class="file-image__hint">click to pin · drag for a region</div>
					</Show>
				</div>
			</Show>
		</>
	)
}

const COMMENT_ICON = (
	<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
		<path
			d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
			fill="currentColor"
		/>
	</svg>
)

const STYLE_ID = "file-image-comments-style"

const ensureStyles = () => {
	if (document.getElementById(STYLE_ID)) return
	const style = document.createElement("style")
	style.id = STYLE_ID
	style.textContent = `
.file-image {
	position: relative;
	height: 100%;
	/* comments are light yellow, like a highlighter */
	--file-comment-accent: var(--comment-mark, #f2c94c);
	--file-comment-fill: var(--comment-highlight, #fff1a8);
	--file-comment-ink: var(--comment-ink, #4d3a00);
}
.file-image > img { display: block; }
.file-image__overlay {
	position: absolute;
	z-index: 2;
	pointer-events: none;
	touch-action: none;
}
.file-image__overlay--commenting {
	pointer-events: auto;
	cursor: crosshair;
	outline: 1px dashed color-mix(in srgb, var(--file-comment-accent) 60%, transparent);
}
.file-image__anchor {
	position: absolute;
	box-sizing: border-box;
	pointer-events: auto;
	cursor: var(--studio-cursor-pointer, pointer);
}
.file-image__overlay--commenting .file-image__anchor { pointer-events: none; }
/* a comment: a yellow line around what it's about */
.file-image__anchor--pin {
	width: 16px;
	height: 16px;
	border-radius: 50%;
	border: 2px solid var(--file-comment-accent);
	background: color-mix(in srgb, var(--file-comment-fill) 55%, transparent);
	box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.8), 0 1px 3px rgba(0, 0, 0, 0.25);
	transform: translate(-50%, -50%);
}
.file-image__anchor--region {
	border: 2px solid var(--file-comment-accent);
	border-radius: 2px;
	box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7);
}
.file-image__anchor--focused.file-image__anchor--region {
	border-width: 3px;
	background: color-mix(in srgb, var(--file-comment-fill) 35%, transparent);
	box-shadow: 0 0 0 4px color-mix(in srgb, var(--file-comment-fill) 70%, transparent);
}
.file-image__anchor--focused.file-image__anchor--pin {
	width: 20px;
	height: 20px;
	box-shadow: 0 0 0 4px color-mix(in srgb, var(--file-comment-fill) 70%, transparent);
}
.file-image__draft {
	position: absolute;
	box-sizing: border-box;
	border: 2px dashed var(--file-comment-accent);
	background: color-mix(in srgb, var(--file-comment-accent) 12%, transparent);
}
.file-image__draft--pin {
	width: 12px !important;
	height: 12px !important;
	border-radius: 50%;
	border-style: solid;
	transform: translate(-50%, -50%);
}
.file-image__comment-button {
	position: absolute;
	top: 8px;
	right: 8px;
	display: inline-flex;
	align-items: center;
	gap: 5px;
	padding: 4px 9px;
	font: 500 12px/1 system-ui, sans-serif;
	color: var(--editor-line, #222);
	background: var(--editor-fill, #fff);
	border: 1px solid color-mix(in srgb, var(--editor-line, #222) 15%, transparent);
	border-radius: 6px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	cursor: var(--studio-cursor-pointer, pointer);
	pointer-events: auto;
	user-select: none;
	white-space: nowrap;
}
.file-image__comment-button svg { display: block; }
.file-image__comment-button--active {
	color: var(--file-comment-ink);
	background: var(--file-comment-fill);
	border-color: var(--file-comment-accent);
}
.file-image__hint {
	position: absolute;
	left: 50%;
	bottom: 8px;
	transform: translateX(-50%);
	padding: 3px 8px;
	border-radius: 4px;
	background: rgba(0, 0, 0, 0.6);
	color: #fff;
	font: 11px/1.3 system-ui, sans-serif;
	white-space: nowrap;
	pointer-events: none;
}
`
	document.head.append(style)
}
