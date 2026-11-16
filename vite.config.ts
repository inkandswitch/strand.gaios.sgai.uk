import {defineConfig} from "vite"
import {dirname, join} from "node:path"
import {fileURLToPath} from "node:url"
import {core, environment, patchwork} from "./vite/environment.ts"
import {bundledPackages} from "./vite/packages.ts"

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	plugins: [
		environment(),
		bundledPackages(join(root, "packages", "static-dist")),
		patchwork({
			storagePrefix: "strand.gaios",
			title: "GAIOS",
			description: "local-first collaborative & malleable software environment",
			server: core ? {fs: {allow: [root, core]}} : undefined,
			syncServers:
				process.env.KEYHIVE === "true" ? {keyhive: "keyhive"} : undefined,
			themeColor: {light: "#ffffff", dark: "#ffffff"},
			html: {attributes: {"data-theme-light": "warm", "data-theme-dark": "dark"}},
			icons: {source: process.env.PATCHWORK_FAVICON ?? "public/strand.svg"},
			// packages/ (gaios-pkg-base), built and bundled by `pnpm packages`,
			// or kept up to date by its watch under `pnpm dev`
			static: [
				{from: join(root, "packages", "static-dist"), watch: ".watch-ready"},
			],
			buildInfo: {
				packageListURL: process.env.PATCHWORK_SYSTEM_PACKAGE_LIST_URL,
			},
		}),
	],
})
