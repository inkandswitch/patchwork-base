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

type ThemePreferencesHandle = {
	url?: string
	doc(): any
	change(fn: (doc: any) => void): void
	on?(event: "change", listener: () => void): void
	off?(event: "change", listener: () => void): void
	whenReady?(): Promise<unknown>
}

const bundledStyleUrls = [themeCssUrl, lycheeCssUrl, gloomCssUrl].map(
	(href) => new URL(href, import.meta.url).href
)
const bundledStyles = new Set(bundledStyleUrls)
const themeLinks = new Map<string, HTMLLinkElement>()
const listeners = new Set<(state: ActiveThemeState) => void>()

let started = false
let currentPrefsHandle: ThemePreferencesHandle | undefined
let currentState: ActiveThemeState | undefined
let storageStarted = false
let unsubscribeStorage: (() => void) | undefined
let unsubscribePrefsChange: (() => void) | undefined

const TOOL_STORAGE_ID = "theme-preferences"

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

function subscribeToProvider<T>(
	element: HTMLElement,
	selector: Record<string, unknown>,
	onValue: (value: T) => void
) {
	const view = element.closest("patchwork-view")
	const dispatchElement = (view as HTMLElement) ?? element
	const channel = new MessageChannel()
	const port = channel.port2
	const controller = new AbortController()

	port.addEventListener(
		"message",
		(event: MessageEvent) => {
			if ((event.data as any)?.type === "change") onValue((event.data as any).value as T)
		},
		{signal: controller.signal}
	)
	port.start()

	dispatchElement.dispatchEvent(
		new CustomEvent("patchwork:subscribe", {
			detail: {selector, port: channel.port1},
			bubbles: true,
			composed: true,
		})
	)

	return () => {
		if (controller.signal.aborted) return
		controller.abort()
		try {
			port.postMessage({type: "unsubscribe"})
		} catch {}
		try {
			port.close()
		} catch {}
	}
}

function ensureThemePreferencesShape(prefsHandle: ThemePreferencesHandle) {
	prefsHandle.change((doc: any) => {
		doc["@patchwork"] = {type: "theme-preferences"}
		if (!doc.light) doc.light = "lychee"
		if (!doc.dark) doc.dark = "gloom"
	})
}

async function useThemePreferencesHandle(prefsHandle: ThemePreferencesHandle) {
	await prefsHandle.whenReady?.()
	ensureThemePreferencesShape(prefsHandle)

	if (currentPrefsHandle === prefsHandle) return
	if (
		currentPrefsHandle?.url &&
		prefsHandle.url &&
		currentPrefsHandle.url === prefsHandle.url
	) {
		return
	}

	unsubscribePrefsChange?.()
	currentPrefsHandle = prefsHandle
	applyFromPrefs()

	prefsHandle.on?.("change", applyFromPrefs)
	unsubscribePrefsChange = () => prefsHandle.off?.("change", applyFromPrefs)
}

async function useToolStoragePreferences(element: HTMLElement, storageUrl: string) {
	const repo = (element as any).repo ?? (window as any).repo
	if (!repo) return

	const prefsHandle = await repo.find(storageUrl)
	await useThemePreferencesHandle(prefsHandle)
}

function connectThemePreferences(element: HTMLElement) {
	if (storageStarted) return

	unsubscribeStorage?.()
	unsubscribePrefsChange?.()
	currentPrefsHandle = undefined
	applyFromPrefs()
	storageStarted = true

	let lastStorageUrl: string | undefined

	unsubscribeStorage = subscribeToProvider<string | undefined>(
		element,
		{type: "patchwork:tool-storage", toolId: TOOL_STORAGE_ID},
		(storageUrl) => {
			if (!storageUrl || storageUrl === lastStorageUrl) return
			lastStorageUrl = storageUrl
			useToolStoragePreferences(element, storageUrl).catch(() => {
				// Theme preferences are best-effort; keep the default theme.
			})
		}
	)
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

export function startActiveTheme(
	element?: HTMLElement,
	preferencesHandle?: ThemePreferencesHandle
) {
	if (preferencesHandle) {
		useThemePreferencesHandle(preferencesHandle).catch(() => {
			// Theme preferences are best-effort; keep the default theme.
		})
	} else if (element) {
		connectThemePreferences(element)
	}
	if (started) return
	started = true

	for (const href of bundledStyleUrls) ensureThemeLink(href)
	watchThemeRegistry()
	applyFromPrefs()

	window
		.matchMedia("(prefers-color-scheme: dark)")
		.addEventListener("change", applyFromPrefs)
}

export function getActiveThemeState() {
	return currentState || snapshot()
}

export function setThemeForCurrentMode(themeId: string) {
	const mode = getMode()
	setThemeForMode(mode, themeId)
}

export function setThemeForMode(mode: "light" | "dark", themeId: string) {
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
