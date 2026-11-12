import { defineConfig } from "vite";
import externals from "@inkandswitch/patchwork-bootloader/externals";

export default defineConfig({
  base: "./",
  build: {
    sourcemap: true,
    emptyOutDir: true,
    minify: false,
    // Icons are files of their own: a mode's `icon` is a URL to one.
    assetsInlineLimit: 0,
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
});
