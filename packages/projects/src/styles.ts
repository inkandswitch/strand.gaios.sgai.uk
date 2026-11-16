import styles from "./styles.css?inline"

/** The frame's and the folder tool's styles, once on the page. */
export function injectStyles() {
	const id = "gaios-projects-styles"
	const existing = document.getElementById(id)
	if (existing) {
		existing.textContent = styles
		return
	}
	const style = document.createElement("style")
	style.id = id
	style.textContent = styles
	document.head.append(style)
}
