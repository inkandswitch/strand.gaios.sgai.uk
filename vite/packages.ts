import type {Plugin} from "vite"
import {readFile, stat} from "node:fs/promises"
import {extname, join, resolve, sep} from "node:path"

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".wasm": "application/wasm",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
}

/**
 * In dev, `/packages/…` comes from the bundled packages (`static-dist`), as
 * it does in the build. The site's own `packages/` folder, the packages'
 * sources, sits at the same path under the site's root, so without this
 * vite serves those instead, and turns a stylesheet a package fetches into
 * a JavaScript module.
 */
export function bundledPackages(staticDist: string): Plugin {
	const rootDir = resolve(staticDist)
	return {
		name: "strand:bundled-packages",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use(async (request, response, next) => {
				let pathname: string
				try {
					pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
				} catch {
					return next()
				}
				if (!pathname.startsWith("/packages/")) return next()
				const path = resolve(join(rootDir, pathname))
				if (!path.startsWith(rootDir + sep)) return next()
				try {
					if (!(await stat(path)).isFile()) return next()
					response.setHeader("Cache-Control", "no-cache")
					response.setHeader(
						"Content-Type",
						CONTENT_TYPES[extname(path)] ?? "application/octet-stream"
					)
					response.end(await readFile(path))
				} catch {
					next()
				}
			})
		},
	}
}
