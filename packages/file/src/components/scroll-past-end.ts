import {EditorView, ViewPlugin, type ViewUpdate} from "@codemirror/view"

/**
 * CodeMirror's `scrollPastEnd`, but only once the text is taller than the
 * editor: then the last line can be scrolled up to the top, and while it
 * all fits, nothing scrolls at all, so the text can't be pushed up off the
 * top of an editor it fits in.
 */
export function scrollPastEndWhenLong() {
	return ViewPlugin.fromClass(
		class {
			padding = -1

			constructor(readonly view: EditorView) {
				this.measure()
			}

			update(update: ViewUpdate) {
				if (update.geometryChanged || update.heightChanged || update.docChanged)
					this.measure()
			}

			measure() {
				this.view.requestMeasure({
					key: this,
					read: view => {
						const visible = view.scrollDOM.clientHeight
						const text = view.lineBlockAt(view.state.doc.length).bottom
						const top = view.documentPadding.top
						if (text + top <= visible) return 0
						return Math.max(0, visible - view.defaultLineHeight - top - 0.5)
					},
					write: (padding, view) => {
						if (padding === this.padding) return
						this.padding = padding
						view.contentDOM.style.paddingBottom = padding ? `${padding}px` : ""
					},
				})
			}

			destroy() {
				this.view.contentDOM.style.paddingBottom = ""
			}
		},
	)
}
