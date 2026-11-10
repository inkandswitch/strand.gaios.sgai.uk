import type {AutomergeUrl} from "@automerge/automerge-repo/slim"
import {accept, type SubscribeEvent} from "@inkandswitch/patchwork-providers"
import {createEffect, on, onCleanup, type Accessor} from "solid-js"

export type SelectedView = {url: AutomergeUrl; toolId: string | null}

type Listener<T> = (value: T) => void

/**
 * Answer `patchwork:selected-doc` (the open document's url, in a list) and
 * `patchwork:selected-view` (that url and the tool showing it) for everything
 * inside `element`. The urls are plain document urls, never locations, so the
 * tools reading them can find the document directly.
 */
export function provideSelection(
	element: HTMLElement,
	view: Accessor<SelectedView | undefined>
) {
	const docListeners = new Set<Listener<AutomergeUrl[]>>()
	const viewListeners = new Set<Listener<SelectedView | null>>()
	const urls = () => {
		const current = view()
		return current ? [current.url] : []
	}

	const onSubscribe = (event: SubscribeEvent) => {
		const {type} = event.detail.selector
		if (type === "patchwork:selected-doc")
			accept<AutomergeUrl[]>(event, respond =>
				listen(docListeners, respond, urls())
			)
		if (type === "patchwork:selected-view")
			accept<SelectedView | null>(event, respond =>
				listen(viewListeners, respond, view() ?? null)
			)
	}

	element.addEventListener("patchwork:subscribe", onSubscribe as EventListener)
	createEffect(
		on(
			view,
			current => {
				for (const respond of docListeners) respond(urls())
				for (const respond of viewListeners) respond(current ?? null)
			},
			{defer: true}
		)
	)
	onCleanup(() => {
		element.removeEventListener(
			"patchwork:subscribe",
			onSubscribe as EventListener
		)
		docListeners.clear()
		viewListeners.clear()
	})
}

function listen<T>(listeners: Set<Listener<T>>, respond: Listener<T>, now: T) {
	respond(now)
	listeners.add(respond)
	return () => {
		listeners.delete(respond)
	}
}
