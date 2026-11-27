const themes = [
	{id: "warm", name: "Warm"},
	{id: "purple", name: "Purple"},
	{id: "teal", name: "Teal"},
	{id: "neutral", name: "Neutral"},
	{id: "dark", name: "Dark"},
]

export const plugins = [
	...themes.map(theme => ({
		type: "patchwork:theme",
		id: theme.id,
		name: theme.name,
		// each theme's stylesheet says its own color-scheme
		style: new URL(`./${theme.id}.css`, import.meta.url).href,
		async load() {
			return {}
		},
	})),
]
