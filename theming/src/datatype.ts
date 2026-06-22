export const ThemePreferencesDatatype = {
	init(doc: any) {
		doc.light = "lychee"
		doc.dark = "gloom"
	},
	getTitle() {
		return "Theme Preferences"
	},
	setTitle() {
		// Theme preferences doc title is not user-editable
	},
}
