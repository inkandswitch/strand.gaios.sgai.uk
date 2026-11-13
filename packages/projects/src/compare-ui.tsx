import {createEffect, createUniqueId, For, onCleanup, Show, createSignal} from "solid-js"
import type {Mode, Options} from "./compare.ts"
import {CaretIcon, CheckIcon} from "./open-with.tsx"

/**
 * A panel's compare mode, in its tab bar: the modes its view takes, the
 * one it prefers first. A dot says one was picked for it.
 */
export function ComparePicker(props: {
	modes: Mode[]
	current: Mode
	overridden: boolean
	pick(id: string | undefined): void
	options(mode: Mode): Options<unknown>
}) {
	const [open, setOpen] = createSignal(false)
	const menuId = createUniqueId()
	let button!: HTMLButtonElement
	let menu!: HTMLDivElement
	const choose = (id: string | undefined) => {
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
				title={`Compare: ${props.current.name}`}
				popovertarget={menuId}>
				<ModeIcon mode={props.current} />
				<CaretIcon />
				<Show when={props.overridden}>
					<span class="projects__compare-dot" aria-label="Its own mode" />
				</Show>
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
				<Item checked={!props.overridden} onClick={() => choose(undefined)}>
					As the view prefers
				</Item>
				<For each={props.modes}>
					{mode => (
						<Item
							checked={props.overridden && mode.id === props.current.id}
							onClick={() => choose(mode.id)}>
							<ModeIcon mode={mode} />
							{mode.name}
						</Item>
					)}
				</For>
				<ModeControls mode={props.current} options={props.options(props.current)} />
			</div>
		</>
	)
}

function Item(props: {checked: boolean; onClick(): void; children: any}) {
	return (
		<button
			type="button"
			role="menuitemradio"
			aria-checked={props.checked}
			class="projects__open-with-item"
			onClick={() => props.onClick()}>
			<span class="projects__open-with-check">
				<Show when={props.checked}>
					<CheckIcon />
				</Show>
			</span>
			{props.children}
		</button>
	)
}

function ModeIcon(props: {mode: Mode}) {
	return <img class="projects__compare-icon" src={props.mode.icon} alt={props.mode.name} />
}

/** Where a mode draws its own controls, if it has any. */
function ModeControls(props: {mode: Mode; options: Options<unknown>}) {
	const [element, setElement] = createSignal<HTMLDivElement>()
	createEffect(() => {
		const controls = props.mode.module.controls
		const at = element()
		if (controls && at) onCleanup(controls(at, props.options))
	})
	return (
		<Show when={props.mode.module.controls}>
			<div ref={setElement} class="projects__compare-controls" />
		</Show>
	)
}
