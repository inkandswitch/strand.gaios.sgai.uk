// Adapted from codemirror-base's lib/extensions/commentUI.ts (tools don't
// share code at build time): a floating "Comment" button on a selection that
// starts a thread on it, and clicking commented text to open its thread in the
// comments sidebar. The threads themselves are shown and written there.
// Whether comments can be made is asked of the host (`canComment`) instead of
// read off the editor's readOnly, since a file the editor won't let you edit
// can still take comments.

import {
	Extension,
	StateEffect,
	StateField,
	type EditorState,
} from "@codemirror/state"
import {EditorView, showTooltip, type Tooltip} from "@codemirror/view"

export type CommentUIOptions = {
	// Start a thread on [from, to]. Called when the "Comment" button is clicked.
	createThreadForRange: (from: number, to: number) => void
	// Open the thread whose commented range covers `pos`, if there is one.
	// Called when the user clicks text.
	openThreadAtPos: (pos: number) => void
	// Whether the doc will take a comment right now. When it won't, there's no
	// "Comment" button.
	canComment: () => boolean
}

// Hide the floating "Comment" button until the next selection change (after
// Escape, or once it's been pressed).
const dismissButton = StateEffect.define<null>()

// A speech-bubble icon + "Comment" label, shown floating above the selection.
const buildCommentButton = (
	from: number,
	to: number,
	view: EditorView,
	options: CommentUIOptions
): HTMLElement => {
	const button = document.createElement("button")
	button.className = "cm-comment-button"
	button.setAttribute("aria-label", "Comment")

	button.innerHTML = `
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
				xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
						fill="currentColor" stroke="none"/>
		</svg>
		<span>Comment</span>
	`

	// Without this, the browser focuses the button on mousedown, the editor
	// blurs, the selection collapses, our tooltip source returns null, and
	// CodeMirror tears down the button before `click` fires — so the first
	// press silently does nothing and the user has to click twice.
	button.addEventListener("mousedown", (e) => {
		e.preventDefault()
		e.stopPropagation()
	})

	button.addEventListener("click", (e) => {
		e.preventDefault()
		e.stopPropagation()
		view.dispatch({effects: dismissButton.of(null)})
		options.createThreadForRange(from, to)
	})

	return button
}

const buttonTooltip = (
	state: EditorState,
	options: CommentUIOptions
): Tooltip | null => {
	const sel = state.selection.main
	if (sel.empty || !options.canComment()) return null

	// Anchor the button at the drag tail (the selection head) rather than the
	// start, so dragging left-to-right lands it on the right and right-to-left
	// on the left.
	return {
		pos: sel.head,
		above: true,
		strictSide: false,
		arrow: false,
		create: (view) => ({
			dom: buildCommentButton(sel.from, sel.to, view, options),
		}),
	}
}

type FieldValue = {
	// The button is hidden while this is true, until a fresh selection re-arms it.
	dismissed: boolean
	tooltip: Tooltip | null
}

const commentButtonField = (options: CommentUIOptions) =>
	StateField.define<FieldValue>({
		create: (state) => ({
			dismissed: false,
			tooltip: buttonTooltip(state, options),
		}),
		update(value, tr) {
			let dismissed = value.dismissed
			for (const effect of tr.effects) {
				if (effect.is(dismissButton)) dismissed = true
			}
			// Any fresh selection re-arms the button.
			if (tr.selection) dismissed = false
			if (!tr.docChanged && !tr.selection && dismissed === value.dismissed) {
				return value
			}
			return {
				dismissed,
				tooltip: dismissed ? null : buttonTooltip(tr.state, options),
			}
		},
		provide: (field) => showTooltip.from(field, (value) => value.tooltip),
	})

// Click commented text to open its thread in the sidebar (on click, so it
// lands after the editor has moved its cursor and written that to focus), and
// Escape to dismiss the floating button.
const commentInteractions = (
	options: CommentUIOptions,
	field: StateField<FieldValue>
): Extension =>
	EditorView.domEventHandlers({
		click(event, view) {
			if (
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				!view.state.selection.main.empty
			) {
				return false
			}
			const pos = view.posAtCoords({x: event.clientX, y: event.clientY})
			if (pos == null) return false
			options.openThreadAtPos(pos)
			return false
		},
		keydown(event, view) {
			if (event.key !== "Escape") return false
			const state = view.state.field(field, false)
			if (!state?.tooltip) return false
			view.dispatch({effects: dismissButton.of(null)})
			return true
		},
	})

// Global colours are lifted into local --cm-comment-* tokens in a
// :root/:host/[theme] block so they re-evaluate when the theme swaps. This
// derivation can't live in the baseTheme below — CodeMirror prefixes every
// non-"&" selector with the editor's scope class, so a `:root` key would
// become `.cm... :root` and never match. It's injected as a plain stylesheet
// instead, and the button reads only the derived tokens. The button is editor
// UI, so it derives from --editor-* (not --studio-*, which is studio chrome).
const COMMENT_BUTTON_VARS_ID = "cm-comment-button-vars"
const ensureCommentButtonVars = (): void => {
	if (
		typeof document === "undefined" ||
		document.getElementById(COMMENT_BUTTON_VARS_ID)
	) {
		return
	}
	const style = document.createElement("style")
	style.id = COMMENT_BUTTON_VARS_ID
	style.textContent = `
		:root, :host, [theme] {
			/* the button sits on the editor surface: bg is the plain editor fill,
				text is the editor ink, and hover lifts a gentle one step up the fill
				ramp. see --text-editor-* in the theme. */
			--cm-comment-button-fg: var(--text-editor-line, #0a2b23);
			--cm-comment-button-bg: var(--text-editor-fill, #35f7ca);
			--cm-comment-button-bg-hover: var(--text-editor-fill-offset-10, #2ce0b6);
		}
	`
	document.head.append(style)
}

const commentUITheme = EditorView.baseTheme({
	".cm-tooltip:has(.cm-comment-button)": {
		border: "none",
		background: "transparent",
		boxShadow: "none",
	},
	".cm-comment-button": {
		display: "inline-flex",
		alignItems: "center",
		gap: "5px",
		padding: "4px 9px",
		font: "inherit",
		fontSize: "12px",
		fontWeight: "500",
		lineHeight: "1",
		color: "var(--cm-comment-button-fg)",
		background: "var(--cm-comment-button-bg)",
		border: "none",
		borderRadius: "6px",
		boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
		cursor: "var(--studio-cursor-pointer, pointer)",
		userSelect: "none",
		whiteSpace: "nowrap",
		transition: "background-color max(1ms, calc(0.15s * var(--studio-motion-scale, 1) * var(--studio-motion-preference, 1)))",
	},
	".cm-comment-button:hover": {
		background: "var(--cm-comment-button-bg-hover)",
	},
	".cm-comment-button svg": {
		display: "block",
	},
})

// The comment UI: the floating "Comment" button on a selection, and clicking
// commented text to open its thread.
export const commentUI = (options: CommentUIOptions): Extension => {
	ensureCommentButtonVars()
	const field = commentButtonField(options)
	return [field, commentInteractions(options, field), commentUITheme]
}
