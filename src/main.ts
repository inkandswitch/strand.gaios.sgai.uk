import setup, {
	hideLoadingAnimation,
	showErrorScreen,
	showLoadingAnimation,
} from "@inkandswitch/patchwork"

// packages/static-dist/modules.json: every package in packages/
const DEFAULT_PACKAGE_LIST = "/modules.json"

const packageListURL = (
	new URLSearchParams(location.search).get("system-package-list") ||
	localStorage.getItem("systemPackageListURL") ||
	import.meta.env.PATCHWORK_SYSTEM_PACKAGE_LIST_URL ||
	import.meta.env.VITE_DEFAULT_MODULES ||
	DEFAULT_PACKAGE_LIST
)
	.split(",")
	.map(source => source.trim())
	.filter(Boolean)

showLoadingAnimation()

window.patchwork = await setup({
	packageListURL,
	accountKey: "gaiosAccountUrl",
	title: "GAIOS",
	// packages/projects
	frameToolId: "gaios-projects",
}).catch(error => {
	showErrorScreen(error, {contact: "chee@inkandswitch.com"})
	throw error
})

hideLoadingAnimation()

window.patchwork.sw
	.connectClassicSync()
	.catch(error => console.error("connectClassicSync failed", error))
