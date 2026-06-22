import type {Extension} from "@codemirror/state"
import themeCssUrl from "./theme.css"
import lycheeCssUrl from "./lychee.css"
import gloomCssUrl from "./gloom.css"

const themeLink = document.createElement("link")
themeLink.rel = "stylesheet"
themeLink.href = themeCssUrl
document.head.appendChild(themeLink)

/** Apply a theme by injecting a <link rel="stylesheet"> and setting [theme] on <html> */
let activeThemeLink: HTMLLinkElement | null = null

function applyTheme(themeId: string, themeStyleUrl: string) {
	document.documentElement.setAttribute("theme", themeId)

	if (activeThemeLink) {
		activeThemeLink.href = themeStyleUrl
	} else {
		activeThemeLink = document.createElement("link")
		activeThemeLink.rel = "stylesheet"
		activeThemeLink.setAttribute("data-patchwork-theme", "active")
		activeThemeLink.href = themeStyleUrl
		document.head.appendChild(activeThemeLink)
	}
}

/**
 * Ensure the account has a theme-preferences doc. Create one if missing.
 * Returns the preferences handle or undefined if repo/account not ready.
 */
async function ensureThemePreferences() {
	const repo = (window as any).repo
	const accountHandle = (window as any).accountDocHandle
	if (!repo || !accountHandle) return undefined

	const accountDoc = accountHandle.doc()
	if (!accountDoc) return undefined

	if (accountDoc.themePreferencesUrl) {
		return await repo.find(accountDoc.themePreferencesUrl)
	}

	// Create the theme-preferences doc and link it to the account
	const prefsHandle = await repo.create2({
		light: "lychee",
		dark: "gloom",
	})
	accountHandle.change((d: any) => {
		d.themePreferencesUrl = prefsHandle.url
	})
	return prefsHandle
}

/** Load and apply the user's preferred theme based on color scheme */
async function loadActiveTheme() {
	try {
		const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches
		let themeId: string | undefined

		const prefsHandle = await ensureThemePreferences()
		if (prefsHandle) {
			const prefs = prefsHandle.doc()
			if (prefs) {
				themeId = isDark ? prefs.dark : prefs.light
			}
		}

		// Default to lychee (light) / gloom (dark) when no preference is set
		if (!themeId) {
			themeId = isDark ? "gloom" : "lychee"
		}

		const registry = (window as any).hive?.getRegistry?.("patchwork:theme")
		if (!registry) {
			// Registry not available yet — apply default directly
			applyTheme(themeId, new URL(isDark ? gloomCssUrl : lycheeCssUrl, import.meta.url).href)
			return
		}

		const themes = registry.list?.() || []
		const theme = themes.find((t: any) => t.id === themeId)
		if (theme?.style) {
			applyTheme(themeId, theme.style)
		}
	} catch {
		// Theme loading is best-effort; fall back to default CSS variables
	}
}

// Listen for color scheme changes to swap themes
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	loadActiveTheme()
})

// Apply theme on load
loadActiveTheme()

export const plugins = [
	{
		type: "codemirror:extension",
		id: "codemirror-theme",
		name: "Theme",
		supportedDatatypes: "*",
		async load(): Promise<Extension[]> {
			const theme = await import("./codemirror-theme.ts")
			return theme.default
		},
	},
	{
		type: "patchwork:theme" as const,
		id: "lychee",
		name: "Lychee",
		style: new URL(lycheeCssUrl, import.meta.url).href,
		async load() {
			return {}
		},
	},
	{
		type: "patchwork:theme" as const,
		id: "gloom",
		name: "Gloom",
		style: new URL(gloomCssUrl, import.meta.url).href,
		async load() {
			return {}
		},
	},
	{
		type: "patchwork:datatype" as const,
		id: "theme-preferences",
		name: "Theme Preferences",
		icon: "Palette",
		unlisted: true,
		async load() {
			const {ThemePreferencesDatatype} = await import("./datatype.ts")
			return ThemePreferencesDatatype
		},
	},
	{
		type: "patchwork:tool" as const,
		id: "theme-picker",
		name: "Theme Picker",
		icon: "Palette",
		supportedDatatypes: ["theme-preferences"],
		async load() {
			const {ThemePickerTool} = await import("./tool.tsx")
			return ThemePickerTool
		},
	},
	{
		type: "patchwork:datatype" as const,
		id: "custom-theme",
		name: "Custom Theme",
		icon: "Paintbrush",
		async load() {
			const {CustomThemeDatatype} = await import("./theme-editor-datatype.ts")
			return CustomThemeDatatype
		},
	},
	{
		type: "patchwork:tool" as const,
		id: "theme-editor",
		name: "Theme Editor",
		icon: "Paintbrush",
		supportedDatatypes: ["custom-theme"],
		async load() {
			const {ThemeEditorTool} = await import("./theme-editor.tsx")
			return ThemeEditorTool
		},
	},
]
