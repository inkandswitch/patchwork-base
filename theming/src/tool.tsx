import {render} from "solid-js/web"
import {createEffect, createSignal, For, Show} from "solid-js"
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
	const [selectedMode, setSelectedMode] = createSignal<"light" | "dark">(
		themeState().mode
	)
	const [showAllLight, setShowAllLight] = createSignal(false)
	const [showAllDark, setShowAllDark] = createSignal(false)

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
		.theme-picker-tabs {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--studio-space-3xs, 0.125rem);
			padding: var(--studio-space-3xs, 0.125rem);
			border: 1px solid var(--studio-chrome-line-offset-40, var(--studio-line-offset-40, #aaa));
			border-radius: var(--studio-radius-sm, 4px);
			background: var(--studio-chrome-fill, var(--studio-fill, white));
		}
		.theme-picker-tab {
			min-width: 0;
			height: 2rem;
			border: 0;
			border-radius: var(--studio-radius-xs, 2px);
			background: transparent;
			color: var(--studio-chrome-line-offset-30, var(--studio-line-offset-30, #555));
			font: 700 0.75rem/1 var(--studio-family-sans, system-ui, sans-serif);
			letter-spacing: 0;
			cursor: pointer;
		}
		.theme-picker-tab:hover {
			background: var(--studio-chrome-fill-offset-20, var(--studio-fill-offset-20, #f2f2f2));
			color: var(--studio-chrome-line, var(--studio-line, black));
		}
		.theme-picker-tab[data-selected] {
			background: var(--studio-chrome-line, var(--studio-line, black));
			color: var(--studio-chrome-fill, var(--studio-fill, white));
		}
		.theme-picker-section {
			display: flex;
			flex-direction: column;
			gap: var(--studio-space-xs, 0.375rem);
		}
		.theme-picker-section-header {
			display: flex;
			align-items: baseline;
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
			border: 1px solid var(--studio-chrome-line-offset-40, var(--studio-fill-offset-20, #e5e5e5));
			border-radius: 2px;
			padding: var(--studio-space-sm, 0.5rem);
			cursor: pointer;
			color: var(--studio-chrome-line, var(--studio-line, black));
			text-align: center;
			font-size: 0.85em;
			aspect-ratio: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			transition: border-color var(--studio-transition-fast, 0.1s ease);
			background: var(--studio-chrome-fill, var(--studio-fill, white));
		}
		.theme-picker-card:hover {
			border-color: var(--studio-chrome-line, var(--studio-line, #999));
		}
		.theme-picker-card[data-selected] {
			box-shadow: inset 0 0 0 1px var(--studio-chrome-line, var(--studio-line, black));
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
		createEffect(() => setSelectedMode(themeState().mode))

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
					Currently using: {themeState().mode} mode
				</p>

				<div class="theme-picker-tabs" role="tablist" aria-label="Theme mode">
					<button
						class="theme-picker-tab"
						role="tab"
						aria-selected={selectedMode() === "light"}
						data-selected={selectedMode() === "light" ? "" : undefined}
						onClick={() => setSelectedMode("light")}
					>
						LIGHT MODE
					</button>
					<button
						class="theme-picker-tab"
						role="tab"
						aria-selected={selectedMode() === "dark"}
						data-selected={selectedMode() === "dark" ? "" : undefined}
						onClick={() => setSelectedMode("dark")}
					>
						DARK MODE
					</button>
				</div>

				<Show when={selectedMode() === "light"}>
				<div class="theme-picker-section" role="tabpanel">
					<Show when={hasHiddenLight()}>
						<div class="theme-picker-section-header">
							<button
								class="theme-picker-show-all"
								onClick={() => setShowAllLight((v) => !v)}
							>
								{showAllLight()
									? "Hide dark themes"
									: "Show dark themes too"}
							</button>
						</div>
					</Show>
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
				</Show>

				<Show when={selectedMode() === "dark"}>
				<div class="theme-picker-section" role="tabpanel">
					<Show when={hasHiddenDark()}>
						<div class="theme-picker-section-header">
							<button
								class="theme-picker-show-all"
								onClick={() => setShowAllDark((v) => !v)}
							>
								{showAllDark()
									? "Hide light themes"
									: "Show light themes too"}
							</button>
						</div>
					</Show>
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
				</Show>
			</div>
		)
	}, element)

	return () => {
		unsubscribeThemeState()
		dispose()
		style.remove()
	}
}
