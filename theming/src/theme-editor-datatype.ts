export interface CustomThemeDoc {
	name: string
	mode: "light" | "dark"
	variables: Record<string, string>
	customCss: string
}

export const EDITABLE_VARIABLES = [
	{group: "Base", vars: [
		{key: "--studio-fill", label: "Fill (background)", type: "color"},
		{key: "--studio-line", label: "Line (foreground)", type: "color"},
	]},
	{group: "Accents", vars: [
		{key: "--studio-primary", label: "Primary", type: "color"},
		{key: "--studio-secondary", label: "Secondary", type: "color"},
		{key: "--studio-danger", label: "Danger", type: "color"},
		{key: "--studio-warning", label: "Warning", type: "color"},
	]},
	{group: "Semantic", vars: [
		{key: "--studio-added", label: "Added", type: "color"},
		{key: "--studio-deleted", label: "Deleted", type: "color"},
		{key: "--studio-modified", label: "Modified", type: "color"},
		{key: "--studio-link", label: "Link", type: "color"},
	]},
	{group: "Selection", vars: [
		{key: "--studio-selection-fill", label: "Selection fill", type: "color"},
	]},
	{group: "Chrome", vars: [
		// derived by default (see theme.css); kept as text so the var() default
		// survives unless the user types a concrete value.
		{key: "--studio-chrome-fill", label: "Chrome fill", type: "text"},
		{key: "--studio-chrome-line", label: "Chrome line", type: "text"},
	]},
	{group: "Sideboard", vars: [
		{key: "--sideboard-primary", label: "Sideboard primary", type: "text"},
		{key: "--sideboard-fill", label: "Sideboard fill", type: "text"},
	]},
	{group: "Typography", vars: [
		{key: "--studio-family-sans", label: "Sans font", type: "text"},
		{key: "--studio-family-code", label: "Code font", type: "text"},
		{key: "--studio-family", label: "Default font", type: "text"},
		{key: "--studio-family-ui", label: "UI font", type: "text"},
		{key: "--studio-font-size", label: "Font size", type: "text"},
		{key: "--studio-line-height", label: "Line height", type: "text"},
	]},
] as const

export const DEFAULT_VALUES: Record<string, string> = {
	"--studio-fill": "#ffffff",
	"--studio-line": "#000000",
	"--studio-primary": "#35f7ca",
	"--studio-secondary": "#33ccf8",
	"--studio-danger": "#ff6a90",
	"--studio-warning": "#f8c43b",
	"--studio-added": "#35f7ca",
	"--studio-deleted": "#ff6a90",
	"--studio-modified": "#f8c43b",
	"--studio-link": "#3366ee",
	"--studio-selection-fill": "#ffee8888",
	// derived defaults — mirror the var() chains in theme.css so editing the
	// source (fill/primary/sans) cascades unless overridden here.
	"--studio-chrome-fill": "var(--studio-fill-offset-10)",
	"--studio-chrome-line": "var(--studio-line)",
	"--sideboard-primary": "var(--studio-primary)",
	"--sideboard-fill": "var(--studio-chrome-fill)",
	"--studio-family-sans": '"Jost*", "Jost", system-ui, -apple-system, sans-serif',
	"--studio-family-code": '"Fantasque Sans Mono", "IBM Plex Mono", ui-monospace, monospace',
	"--studio-family": "var(--studio-family-sans)",
	"--studio-family-ui": "var(--studio-family-sans)",
	"--studio-font-size": "16px",
	"--studio-line-height": "1.5",
}

export const CustomThemeDatatype = {
	init(doc: any) {
		doc.name = "Custom Theme"
		doc.mode = "light"
		doc.variables = {...DEFAULT_VALUES}
		doc.customCss = ""
	},
	getTitle(doc: any) {
		return doc.name || "Custom Theme"
	},
	setTitle(doc: any, title: string) {
		doc.name = title
	},
}
