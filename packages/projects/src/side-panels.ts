import {createSignal, type Accessor} from "solid-js"

const HISTORY_KEY = "gaios-projects:history"
const COMMENTS_KEY = "gaios-projects:comments"

/**
 * The column beside the card: the history and the comments, each folded or
 * not. Remembered in this browser.
 */
export type SidePanels = {
	history: Accessor<boolean>
	comments: Accessor<boolean>
	toggleHistory(): void
	toggleComments(): void
	/** unfolds the comments, for a thread a tool asked to show */
	showComments(): void
}

export function createSidePanels(): SidePanels {
	const [history, setHistory] = createSignal(read(HISTORY_KEY) === "open")
	const [comments, setComments] = createSignal(read(COMMENTS_KEY) === "1")
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
		toggleHistory: () => showHistory(!history()),
		toggleComments: () => showComments(!comments()),
		showComments: () => showComments(true),
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
