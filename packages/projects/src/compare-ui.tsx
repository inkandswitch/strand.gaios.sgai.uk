import {createEffect, createSignal, createUniqueId, For, onCleanup, Show} from "solid-js"
import type {Mode, Options, Versions} from "./compare.ts"
import {CaretIcon, CheckIcon} from "./open-with.tsx"

/**
 * A compare mode to pick, from the modes offered: a panel's, in its tab bar,
 * or every panel's at once, in the workspace's header. Shows the current
 * one, if there is one.
 */
export function ComparePicker(props: {
	modes: Mode[]
	current: Mode | undefined
	title: string
	pick(id: string): void
}) {
	const name = (mode: Mode) => mode.name
	const [open, setOpen] = createSignal(false)
	const menuId = createUniqueId()
	let button!: HTMLButtonElement
	let menu!: HTMLDivElement
	const choose = (id: string) => {
		menu.hidePopover()
		props.pick(id)
	}
	return (
		<>
			<button
				ref={button}
				type="button"
				class="projects__compare-picker"
				aria-haspopup="menu"
				aria-expanded={open()}
				title={props.current ? `${props.title}: ${name(props.current)}` : props.title}
				popovertarget={menuId}>
				<Show when={props.current} fallback={<span class="projects__compare-label">Mode</span>}>
					{current => <ModeIcon mode={current()} name={name(current())} />}
				</Show>
				<CaretIcon />
			</button>
			<div
				ref={menu}
				id={menuId}
				popover="auto"
				role="menu"
				class="projects__open-with-menu"
				onBeforeToggle={event => {
					if (event.newState !== "open") return
					const box = button.getBoundingClientRect()
					menu.style.top = `${box.bottom + 4}px`
					menu.style.right = `${window.innerWidth - box.right}px`
				}}
				onToggle={event => setOpen(event.newState === "open")}>
				<For each={props.modes}>
					{mode => (
						<button
							type="button"
							role="menuitemradio"
							aria-checked={mode.id === props.current?.id}
							class="projects__open-with-item"
							onClick={() => choose(mode.id)}>
							<span class="projects__open-with-check">
								<Show when={mode.id === props.current?.id}>
									<CheckIcon />
								</Show>
							</span>
							<ModeIcon mode={mode} name={name(mode)} />
							{name(mode)}
						</button>
					)}
				</For>
			</div>
		</>
	)
}

/** Folds away what's the same on both versions, in a view that can. */
export function CollapseToggle(props: {collapsed: boolean; toggle(): void}) {
	return (
		<button
			type="button"
			class="projects__compare-picker"
			aria-pressed={props.collapsed}
			title={props.collapsed ? "Show unchanged" : "Collapse unchanged"}
			onClick={() => props.toggle()}>
			<CollapseIcon />
		</button>
	)
}

/** Where a mode draws its own controls, if it has any. */
export function ModeControls(props: {
	mode: Mode
	options: Options<unknown>
	versions: Versions | undefined
}) {
	const [element, setElement] = createSignal<HTMLDivElement>()
	createEffect(() => {
		const controls = props.mode.module.controls
		const at = element()
		if (controls && at) onCleanup(controls(at, props.options, props.versions))
	})
	return (
		<Show when={props.mode.module.controls}>
			<div ref={setElement} class="projects__compare-controls" />
		</Show>
	)
}

function ModeIcon(props: {mode: Mode; name: string}) {
	return <img class="projects__compare-icon" src={props.mode.icon} alt={props.name} />
}

// lucide `fold-vertical`
function CollapseIcon() {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true">
			<path d="M12 22v-6" />
			<path d="M12 8V2" />
			<path d="M4 12H2" />
			<path d="M10 12H8" />
			<path d="M16 12h-2" />
			<path d="M22 12h-2" />
			<path d="m15 19-3-3-3 3" />
			<path d="m15 5-3 3-3-3" />
		</svg>
	)
}
