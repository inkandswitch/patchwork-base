import {getRegistry} from "@inkandswitch/patchwork-plugins"
import themeCssUrl from "./theme.css"
import lycheeCssUrl from "./lychee.css"
import gloomCssUrl from "./gloom.css"

type ActiveThemeState = {
	mode: "light" | "dark"
	themeId: string
	light: string
	dark: string
	preferencesUrl?: string
}

const bundledStyleUrls = [themeCssUrl, lycheeCssUrl, gloomCssUrl].map(
	(href) => new URL(href, import.meta.url).href
)
const bundledStyles = new Set(bundledStyleUrls)
const themeLinks = new Map<string, HTMLLinkElement>()
const listeners = new Set<(state: ActiveThemeState) => void>()

let started = false
let currentPrefsHandle: any = undefined
let currentState: ActiveThemeState | undefined

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

function getMode(): "light" | "dark" {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light"
}

function getPreferredThemeId(prefs: any): string {
	const mode = getMode()
	const themeId = prefs ? (mode === "dark" ? prefs.dark : prefs.light) : undefined
	return themeId || (mode === "dark" ? "gloom" : "lychee")
}

function snapshot(): ActiveThemeState {
	const prefs = currentPrefsHandle?.doc()
	const mode = getMode()
	return {
		mode,
		themeId: getPreferredThemeId(prefs),
		light: prefs?.light || "lychee",
		dark: prefs?.dark || "gloom",
		preferencesUrl: currentPrefsHandle?.url,
	}
}

function emit() {
	currentState = snapshot()
	for (const listener of listeners) listener(currentState)
}

function applyTheme(themeId: string) {
	if (themeId) document.documentElement.setAttribute("theme", themeId)
}

function applyFromPrefs() {
	applyTheme(getPreferredThemeId(currentPrefsHandle?.doc()))
	emit()
}

/** Poll for the global repo + account handle, which are set asynchronously. */
function waitForGlobals(): Promise<{repo: any; accountHandle: any}> {
	return new Promise((resolve) => {
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
		applyFromPrefs()
		prefsHandle.on("change", applyFromPrefs)
	}

	await resolvePrefs()
	accountHandle.on("change", resolvePrefs)
}

function watchThemeRegistry() {
	const themeRegistry = getRegistry("patchwork:theme") as any

	for (const theme of themeRegistry.all?.() || []) {
		if (theme.style) ensureThemeLink(theme.style)
	}

	themeRegistry.on("registered", (plugin: any) => {
		if (plugin.style) ensureThemeLink(plugin.style)
	})
	themeRegistry.on("removed", () => {
		const knownStyles = new Set(
			(themeRegistry.all?.() || [])
				.map((t: any) => t.style)
				.filter(Boolean)
		)
		for (const [style] of themeLinks) {
			if (!bundledStyles.has(style) && !knownStyles.has(style)) {
				removeThemeLink(style)
			}
		}
	})
}

export function startActiveTheme() {
	if (started) return
	started = true

	for (const href of bundledStyleUrls) ensureThemeLink(href)
	watchThemeRegistry()
	applyFromPrefs()

	window
		.matchMedia("(prefers-color-scheme: dark)")
		.addEventListener("change", applyFromPrefs)

	loadActiveTheme().catch(() => {
		// Theme loading is best-effort; fall back to the already-applied default.
	})
}

export function getActiveThemeState() {
	return currentState || snapshot()
}

export function setThemeForCurrentMode(themeId: string) {
	const mode = getMode()
	currentPrefsHandle?.change((doc: any) => {
		doc[mode] = themeId
	})
}

export function hasThemePreferences() {
	return Boolean(currentPrefsHandle)
}

export function onActiveThemeChange(listener: (state: ActiveThemeState) => void) {
	listeners.add(listener)
	listener(getActiveThemeState())
	return () => listeners.delete(listener)
}
