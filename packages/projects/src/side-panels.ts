import {createSignal, type Accessor} from "solid-js"

const HISTORY_KEY = "gaios-projects:history"
const COMMENTS_KEY = "gaios-projects:comments"
const SCOPE_KEY = "gaios-projects:scope"

/** What the history and the comments are about: the documents open, or all of them. */
export type PanelScope = "open" | "all"

/**
 * The column beside the card: the history and the comments, each folded or
 * not, and what both are about. Remembered in this browser.
 */
export type SidePanels = {
	history: Accessor<boolean>
	comments: Accessor<boolean>
	scope: Accessor<PanelScope>
	toggleHistory(): void
	toggleComments(): void
	/** unfolds the comments, for a thread a tool asked to show */
	showComments(): void
	setScope(scope: PanelScope): void
}

export function createSidePanels(): SidePanels {
	const [history, setHistory] = createSignal(read(HISTORY_KEY) === "open")
	const [comments, setComments] = createSignal(read(COMMENTS_KEY) === "1")
	const [scope, setScope] = createSignal<PanelScope>(read(SCOPE_KEY) === "open" ? "open" : "all")
	const showHistory = (next: boolean) => {
		setHistory(next)
		write(HISTORY_KEY, next ? "open" : "closed")
	}
	const showComments = (next: boolean) => {
		setComments(next)
		write(COMMENTS_KEY, next ? "1" : "0")
	}
	return {
		history,
		comments,
		scope,
		toggleHistory: () => showHistory(!history()),
		toggleComments: () => showComments(!comments()),
		showComments: () => showComments(true),
		setScope(next) {
			setScope(next)
			write(SCOPE_KEY, next)
		},
	}
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

function write(key: string, value: string) {
	try {
		localStorage.setItem(key, value)
	} catch {
		// remembered for this page only
	}
}
