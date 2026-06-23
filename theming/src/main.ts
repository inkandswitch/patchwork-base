import type {Extension} from "@codemirror/state"
import {getRegistry} from "@inkandswitch/patchwork-plugins"
import themeCssUrl from "./theme.css"
import lycheeCssUrl from "./lychee.css"
import gloomCssUrl from "./gloom.css"

// Include bundled theme CSS files early (before registry is ready)
const themeLinks = new Map<string, HTMLLinkElement>()

function ensureThemeLink(style: string) {
	if (themeLinks.has(style)) return
	const link = document.createElement("link")
	link.rel = "stylesheet"
	link.href = style
	document.head.appendChild(link)
	themeLinks.set(style, link)
}

function removeThemeLink(style: string) {
	const link = themeLinks.get(style)
	if (link) {
		link.remove()
		themeLinks.delete(style)
	}
}

for (const href of [themeCssUrl, lycheeCssUrl, gloomCssUrl]) {
	ensureThemeLink(new URL(href, import.meta.url).href)
}

// Watch the theme registry and include all theme CSS files
const themeRegistry = getRegistry("patchwork:theme")

for (const theme of themeRegistry.all?.() || []) {
	if (theme.style) ensureThemeLink(theme.style)
}

themeRegistry.on("registered", (plugin: any) => {
	if (plugin.style) ensureThemeLink(plugin.style)
})
themeRegistry.on("removed", () => {
	const knownStyles = new Set(
		(themeRegistry.all?.() || []).map((t: any) => t.style).filter(Boolean)
	)
	for (const [style] of themeLinks) {
		if (!knownStyles.has(style)) removeThemeLink(style)
	}
})

// The theme name is set on <html> unconditionally — even if no theme plugin
// providing that name has loaded yet. The matching CSS just isn't applied until
// the plugin registers, but the attribute is always correct.
function applyTheme(themeId: string) {
	if (themeId) document.documentElement.setAttribute("theme", themeId)
}

function getPreferredThemeId(prefs: any): string {
	const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches
	const themeId = prefs ? (isDark ? prefs.dark : prefs.light) : undefined
	return themeId || (isDark ? "gloom" : "lychee")
}

// The most recently resolved preferences doc, if any. Used so the
// color-scheme-change listener can re-apply without re-resolving the doc.
let currentPrefsHandle: any = undefined

function applyFromPrefs() {
	applyTheme(getPreferredThemeId(currentPrefsHandle?.doc()))
}

// Apply a best-guess theme immediately so <html> always has a theme attribute,
// before the repo, account doc, or preferences doc have loaded.
applyFromPrefs()

// Re-apply on OS color-scheme changes (uses the cached prefs doc if present).
window
	.matchMedia("(prefers-color-scheme: dark)")
	.addEventListener("change", applyFromPrefs)

/** Poll for the global repo + account handle, which are set asynchronously. */
function waitForGlobals(): Promise<{repo: any; accountHandle: any}> {
	return new Promise(resolve => {
		const check = () => {
			const repo = (window as any).repo
			const accountHandle = (window as any).accountDocHandle
			if (repo && accountHandle) {
				resolve({repo, accountHandle})
				return true
			}
			return false
		}
		if (check()) return
		const interval = setInterval(() => {
			if (check()) clearInterval(interval)
		}, 100)
	})
}

/**
 * Resolve the account's theme-preferences doc, creating it if missing.
 * Returns the preferences handle, or undefined if the account doc isn't ready.
 */
async function ensureThemePreferences(repo: any, accountHandle: any) {
	const accountDoc = accountHandle.doc()
	if (!accountDoc) return undefined

	if (accountDoc.themePreferencesUrl) {
		return await repo.find(accountDoc.themePreferencesUrl)
	}

	// Create the theme-preferences doc
	const prefsHandle = await repo.create2({
		"@patchwork": {type: "theme-preferences"},
		light: "lychee",
		dark: "gloom",
	})
	accountHandle.change((d: any) => {
		if (!d.themePreferencesUrl) d.themePreferencesUrl = prefsHandle.url
	})
	return prefsHandle
}

/**
 * Wait for the repo/account/preferences docs to load, then apply the preferred
 * theme and keep it in sync. The theme is always (re-)applied as soon as the
 * preferences doc loads, and whenever it — or the account doc's pointer to
 * it — changes afterwards.
 */
async function loadActiveTheme() {
	const {repo, accountHandle} = await waitForGlobals()
	await accountHandle.whenReady?.()

	let lastPrefsUrl: string | undefined
	const resolvePrefs = async () => {
		const prefsHandle = await ensureThemePreferences(repo, accountHandle)
		if (!prefsHandle || prefsHandle.url === lastPrefsUrl) return
		lastPrefsUrl = prefsHandle.url
		await prefsHandle.whenReady?.()
		currentPrefsHandle = prefsHandle
		// Apply as soon as the preferences doc is loaded...
		applyFromPrefs()
		// ...and on every subsequent change (e.g. via the theme picker).
		prefsHandle.on("change", applyFromPrefs)
	}

	await resolvePrefs()
	// The account doc may gain (or change) its themePreferencesUrl later.
	accountHandle.on("change", resolvePrefs)
}

loadActiveTheme().catch(() => {
	// Theme loading is best-effort; fall back to the already-applied default.
})

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
