import {onCleanup} from "solid-js"
import {
	EditorView,
	lineNumbers,
	highlightSpecialChars,
	highlightActiveLineGutter,
	highlightActiveLine,
	keymap,
} from "@codemirror/view"
import {EditorState} from "@codemirror/state"
import {bracketMatching, foldGutter, foldKeymap} from "@codemirror/language"
import {highlightSelectionMatches, searchKeymap} from "@codemirror/search"
import {defaultKeymap} from "@codemirror/commands"
import codemirrorTheme from "../codemirror-theme"
import {getLanguageExtension} from "../languages"
import type {FileDoc} from "../types"

export function LongTextFileViewer(props: {doc: FileDoc}) {
	const languageExtension = getLanguageExtension(
		props.doc.extension,
		props.doc.mimeType,
	)

	const view = new EditorView({
		doc: props.doc.content?.toString() || "",
		extensions: [
			EditorState.readOnly.of(true),
			EditorView.editable.of(false),
			lineNumbers(),
			highlightSpecialChars(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			foldGutter(),
			bracketMatching(),
			EditorState.tabSize.of(2),
			EditorView.lineWrapping,
			keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
			languageExtension,
			...codemirrorTheme,
		],
	})

	onCleanup(() => {
		view.destroy()
	})

	return (
		<div
			ref={(el) => {
				el.appendChild(view.dom)
			}}
			style={{
				width: "100%",
				height: "100%",
			}}
		/>
	)
}
