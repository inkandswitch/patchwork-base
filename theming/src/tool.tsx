import {render} from "solid-js/web"
import {createSignal, For, Show} from "solid-js"
import {getRegistry} from "@inkandswitch/patchwork-plugins"
import {
	getActiveThemeState,
	onActiveThemeChange,
	setThemeForMode,
	startActiveTheme,
} from "./active-theme.ts"

async function detectColorScheme(
	theme: any
): Promise<"light" | "dark" | undefined> {
	if (theme.colorScheme) return theme.colorScheme
	if (!theme.style) return undefined
	try {
		const res = await fetch(theme.style)
		const css = await res.text()
		const match = css.match(/color-scheme:\s*(light|dark)/)
		return (match?.[1] as "light" | "dark") ?? undefined
	} catch {
		return undefined
	}
}

export function ThemePickerTool(_handle: any, element: HTMLElement) {
	startActiveTheme(element)

	const [themeState, setThemeState] = createSignal(getActiveThemeState())
	const unsubscribeThemeState = onActiveThemeChange(setThemeState)

	const [themes, setThemes] = createSignal<any[]>([])
	const [colorSchemes, setColorSchemes] = createSignal<
		Record<string, "light" | "dark" | undefined>
	>({})
	const [isDark, setIsDark] = createSignal(
		window.matchMedia("(prefers-color-scheme: dark)").matches
	)
	const [showAllLight, setShowAllLight] = createSignal(false)
	const [showAllDark, setShowAllDark] = createSignal(false)

	// Watch for color scheme changes
	const mq = window.matchMedia("(prefers-color-scheme: dark)")
	const onSchemeChange = (e: MediaQueryListEvent) => setIsDark(e.matches)
	mq.addEventListener("change", onSchemeChange)

	async function detectAll(themeList: any[]) {
		const schemes: Record<string, "light" | "dark" | undefined> = {}
		await Promise.all(
			themeList.map(async (t) => {
				schemes[t.id] = await detectColorScheme(t)
			})
		)
		setColorSchemes(schemes)
	}

	// Discover available themes from registry
	const themeRegistry = getRegistry("patchwork:theme")
	const initial = themeRegistry.all?.() || []
	setThemes(initial)
	detectAll(initial)
	const onRegistered = () => {
		const all = themeRegistry.all?.() || []
		setThemes(all)
		detectAll(all)
	}
	themeRegistry.on("registered", onRegistered)
	themeRegistry.on("removed", onRegistered)

	const lightThemes = () => {
		const schemes = colorSchemes()
		if (showAllLight()) return themes()
		return themes().filter((t) => schemes[t.id] !== "dark")
	}

	const darkThemes = () => {
		const schemes = colorSchemes()
		if (showAllDark()) return themes()
		return themes().filter((t) => schemes[t.id] !== "light")
	}

	const hasHiddenLight = () => {
		const schemes = colorSchemes()
		return themes().some((t) => schemes[t.id] === "dark")
	}

	const hasHiddenDark = () => {
		const schemes = colorSchemes()
		return themes().some((t) => schemes[t.id] === "light")
	}

	const style = document.createElement("style")
	style.textContent = `
		.theme-picker {
			padding: var(--studio-space-md, 1rem);
			font-family: var(--studio-family-sans, system-ui, sans-serif);
			color: var(--studio-line, black);
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-md, 1rem);
		}
		.theme-picker-heading {
			font-size: 1.1em;
			font-weight: 600;
			margin: 0;
		}
		.theme-picker-section {
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-xs, 0.375rem);
		}
		.theme-picker-section-header {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
		}
		.theme-picker-label {
			font-size: 0.85em;
			font-weight: 500;
			color: var(--studio-line-offset-40, #666);
		}
		.theme-picker-show-all {
			font-size: 0.75em;
			color: var(--studio-link-text, var(--studio-link, #36e));
			cursor: pointer;
			background: none;
			border: none;
			padding: 0;
			font-family: inherit;
		}
		.theme-picker-show-all:hover {
			text-decoration: underline;
		}
		.theme-picker-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
			gap: var(--studio-space-3xs, 0.125rem);
		}
		.theme-picker-card {
			border: 1px solid var(--studio-fill-offset-20, #e5e5e5);
			border-radius: 2px;
			padding: var(--studio-space-sm, 0.5rem);
			cursor: pointer;
			text-align: center;
			font-size: 0.85em;
			aspect-ratio: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			transition: border-color var(--studio-transition-fast, 0.1s ease);
			background: var(--studio-fill, white);
		}
		.theme-picker-card:hover {
			border-color: var(--studio-fill-offset-40, #999);
		}
		.theme-picker-card[data-selected] {
			border-color: var(--studio-primary-line, var(--studio-primary, #35f7ca));
		}
		.theme-picker-active {
			font-size: 0.8em;
			color: var(--studio-line-offset-50, #999);
			font-style: italic;
		}
	`
	element.appendChild(style)

	const dispose = render(() => {
		const lightId = () => themeState().light
		const darkId = () => themeState().dark

		function selectLight(id: string) {
			setThemeForMode("light", id)
		}

		function selectDark(id: string) {
			setThemeForMode("dark", id)
		}

		return (
			<div class="theme-picker">
				<h2 class="theme-picker-heading">Theme</h2>
				<p class="theme-picker-active">
					Currently using: {isDark() ? "dark" : "light"} mode
				</p>

				<div class="theme-picker-section">
					<div class="theme-picker-section-header">
						<span class="theme-picker-label">Light theme</span>
						<Show when={hasHiddenLight()}>
							<button
								class="theme-picker-show-all"
								onClick={() => setShowAllLight((v) => !v)}
							>
								{showAllLight() ? "show matching" : "show all"}
							</button>
						</Show>
					</div>
					<div class="theme-picker-grid">
						<For each={lightThemes()}>
							{(theme) => (
								<div
									class="theme-picker-card"
									theme={theme.id}
									data-selected={lightId() === theme.id ? "" : undefined}
									onClick={() => selectLight(theme.id)}
								>
									{theme.name}
								</div>
							)}
						</For>
					</div>
				</div>

				<div class="theme-picker-section">
					<div class="theme-picker-section-header">
						<span class="theme-picker-label">Dark theme</span>
						<Show when={hasHiddenDark()}>
							<button
								class="theme-picker-show-all"
								onClick={() => setShowAllDark((v) => !v)}
							>
								{showAllDark() ? "show matching" : "show all"}
							</button>
						</Show>
					</div>
					<div class="theme-picker-grid">
						<For each={darkThemes()}>
							{(theme) => (
								<div
									class="theme-picker-card"
									theme={theme.id}
									data-selected={darkId() === theme.id ? "" : undefined}
									onClick={() => selectDark(theme.id)}
								>
									{theme.name}
								</div>
							)}
						</For>
					</div>
				</div>
			</div>
		)
	}, element)

	return () => {
		unsubscribeThemeState()
		mq.removeEventListener("change", onSchemeChange)
		dispose()
		style.remove()
	}
}
