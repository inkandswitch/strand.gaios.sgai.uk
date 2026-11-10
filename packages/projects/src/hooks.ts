import type {AutomergeUrl, DocHandle, Repo} from "@automerge/automerge-repo/slim"
import type {HasPatchworkMetadata} from "@inkandswitch/patchwork-filesystem"
import {
	getRegistry,
	isLoadedPlugin,
	type DatatypeDescription,
	type LoadedDatatype,
} from "@inkandswitch/patchwork-plugins"
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	type Accessor,
} from "solid-js"
import {asString} from "./folders.ts"

/** A document's title, by its datatype, kept current as the document changes. */
export function useDocTitle(
	repo: Repo,
	url: Accessor<AutomergeUrl | undefined>
): Accessor<string | undefined> {
	const doc = useDoc(useHandle<HasPatchworkMetadata>(repo, url))
	const type = createMemo(() => asString(doc()?.["@patchwork"]?.type))
	const [datatype, setDatatype] = createSignal<LoadedDatatype>()
	createEffect(() => {
		const id = type()
		setDatatype(undefined)
		if (!id) return
		let live = true
		void getRegistry<DatatypeDescription>("patchwork:datatype")
			.load(id)
			.then(loaded => {
				if (live && loaded && isLoadedPlugin(loaded))
					setDatatype(() => loaded as LoadedDatatype)
			})
		onCleanup(() => (live = false))
	})
	return () => {
		const current = doc()
		const loaded = datatype()
		if (!current || !loaded) return undefined
		return loaded.module.getTitle(current) || undefined
	}
}

export function useHandle<T>(
	repo: Repo,
	url: Accessor<AutomergeUrl | undefined>
): Accessor<DocHandle<T> | undefined> {
	const [handle, setHandle] = createSignal<DocHandle<T>>()
	createEffect(() => {
		const current = url()
		setHandle(undefined)
		if (!current) return
		let live = true
		repo.find<T>(current).then(
			found => live && setHandle(() => found),
			error => console.warn(`projects: couldn't load ${current}`, error)
		)
		onCleanup(() => (live = false))
	})
	return handle
}

export function useDoc<T>(
	handle: Accessor<DocHandle<T> | undefined>
): Accessor<T | undefined> {
	const [doc, setDoc] = createSignal<T | undefined>(undefined, {equals: false})
	createEffect(() => {
		const current = handle()
		if (!current) return void setDoc(undefined)
		const update = () => void setDoc(() => current.doc())
		update()
		current.on("change", update)
		onCleanup(() => current.off("change", update))
	})
	return doc
}

/**
 * Whether a provider `<patchwork-view>` has mounted, so whatever subscribes
 * to it can wait until it's listening.
 */
export function useMounted(
	componentId: string,
	element: Accessor<HTMLElement | undefined>
): Accessor<boolean> {
	const [mounted, setMounted] = createSignal(false)
	createEffect(() => {
		const current = element()
		if (!current) return
		const onMounted = (event: Event) => {
			const detail = (event as CustomEvent<{componentId?: string}>).detail
			if (detail?.componentId === componentId) setMounted(true)
		}
		current.addEventListener("patchwork:mounted", onMounted)
		onCleanup(() => current.removeEventListener("patchwork:mounted", onMounted))
	})
	return mounted
}
