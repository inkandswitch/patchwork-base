import {render} from "solid-js/web"
import {createSignal, createEffect, For, onCleanup} from "solid-js"

export function ThemePickerTool(handle: any, element: HTMLElement) {
	const [doc, setDoc] = createSignal(handle.doc())
	const onChange = () => setDoc(handle.doc())
	handle.on("change", onChange)

	const [themes, setThemes] = createSignal<any[]>([])
	const [isDark, setIsDark] = createSignal(
		window.matchMedia("(prefers-color-scheme: dark)").matches
	)

	// Watch for color scheme changes
	const mq = window.matchMedia("(prefers-color-scheme: dark)")
	const onSchemeChange = (e: MediaQueryListEvent) => setIsDark(e.matches)
	mq.addEventListener("change", onSchemeChange)

	// Discover available themes from registry
	createEffect(() => {
		const registry = (window as any).hive?.getRegistry?.("patchwork:theme")
		if (registry) {
			setThemes(registry.list?.() || [])
		}
	})

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
		.theme-picker-label {
			font-size: 0.85em;
			font-weight: 500;
			color: var(--studio-line-offset-40, #666);
		}
		.theme-picker-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
			gap: var(--studio-space-sm, 0.5rem);
		}
		.theme-picker-card {
			border: 2px solid var(--studio-fill-offset-20, #e5e5e5);
			border-radius: var(--studio-radius-md, 8px);
			padding: var(--studio-space-sm, 0.5rem);
			cursor: pointer;
			text-align: center;
			font-size: 0.85em;
			transition: border-color var(--studio-transition-fast, 0.1s ease);
			background: var(--studio-fill, white);
		}
		.theme-picker-card:hover {
			border-color: var(--studio-fill-offset-40, #999);
		}
		.theme-picker-card[data-selected] {
			border-color: var(--studio-primary, #35f7ca);
		}
		.theme-picker-active {
			font-size: 0.8em;
			color: var(--studio-line-offset-50, #999);
			font-style: italic;
		}
	`
	element.appendChild(style)

	const dispose = render(() => {
		const currentDoc = doc()
		const lightId = () => doc()?.light || "lychee"
		const darkId = () => doc()?.dark || "gloom"

		function selectLight(id: string) {
			handle.change((d: any) => {
				d.light = id
			})
		}

		function selectDark(id: string) {
			handle.change((d: any) => {
				d.dark = id
			})
		}

		return (
			<div class="theme-picker">
				<h2 class="theme-picker-heading">Theme</h2>
				<p class="theme-picker-active">
					Currently using: {isDark() ? "dark" : "light"} mode
				</p>

				<div class="theme-picker-section">
					<span class="theme-picker-label">Light theme</span>
					<div class="theme-picker-grid">
						<For each={themes()}>
							{(theme) => (
								<div
									class="theme-picker-card"
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
					<span class="theme-picker-label">Dark theme</span>
					<div class="theme-picker-grid">
						<For each={themes()}>
							{(theme) => (
								<div
									class="theme-picker-card"
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
		handle.off("change", onChange)
		mq.removeEventListener("change", onSchemeChange)
		dispose()
		style.remove()
	}
}
