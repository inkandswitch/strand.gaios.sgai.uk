// dockview-core's ES module build leaves its stylesheet out; the UMD build
// is the same library with the stylesheet added to the page as it loads.
declare module "dockview-core/dist/dockview-core.js" {
	export * from "dockview-core"
}
