import externals from "@inkandswitch/patchwork-bootloader/externals"
import {defineConfig} from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
	base: "./",
	plugins: [solid()],
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: true,
		minify: false,
		rollupOptions: {
			external: externals,
			input: "./src/index.ts",
			output: {
				format: "es",
				entryFileNames: "[name].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name][extname]",
			},
			preserveEntrySignatures: "strict",
		},
	},
})
