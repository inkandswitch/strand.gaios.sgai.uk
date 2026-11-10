import type {Plugin, ToolImplementation} from "@inkandswitch/patchwork-plugins"
import type {AccountDoc} from "./types.ts"

export const plugins: Plugin<any>[] = [
	{
		type: "patchwork:datatype",
		id: "account",
		name: "GAIOS Account",
		icon: "UserCircle",
		unlisted: true,
		async load() {
			const {AccountDatatype} = await import("./account.ts")
			return AccountDatatype
		},
	},
	{
		type: "patchwork:tool",
		id: "gaios-projects",
		tags: ["frame-tool"],
		name: "Projects",
		icon: "Window",
		supportedDatatypes: ["account"],
		load: loadFrame,
	},
]

async function loadFrame(): Promise<ToolImplementation<AccountDoc>> {
	const {renderFrame} = await import("./frame.tsx")
	// Safari can run the impl before the chunk's own top-level code has
	// finished evaluating; a macrotask lets the module graph settle first.
	await new Promise(resolve => setTimeout(resolve))
	return renderFrame
}
