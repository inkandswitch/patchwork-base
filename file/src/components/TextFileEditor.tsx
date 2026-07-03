import {onCleanup} from "solid-js"
import {
	EditorView,
	lineNumbers,
	highlightSpecialChars,
	highlightActiveLineGutter,
	highlightActiveLine,
	rectangularSelection,
	keymap,
} from "@codemirror/view"
import {EditorState} from "@codemirror/state"
import {
	indentUnit,
	bracketMatching,
	foldGutter,
	foldKeymap,
} from "@codemirror/language"
import {
	highlightSelectionMatches,
	searchKeymap,
} from "@codemirror/search"
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
	emacsStyleKeymap,
} from "@codemirror/commands"
import {automergeSyncPlugin} from "@automerge/automerge-codemirror"
import {isImmutableString} from "@automerge/automerge-repo"
import codemirrorTheme from "../codemirror-theme"
import {getLanguageExtension} from "../languages"
import type {FileDoc} from "../types"

enum mod {
	shift = 1,
	control = 2,
	option = 3,
	command = 4,
}

function modshift(event: {
	ctrlKey: boolean
	shiftKey: boolean
	altKey: boolean
	metaKey: boolean
}) {
	let bits = 0
	bits |= +event.shiftKey << mod.shift
	bits |= +event.ctrlKey << mod.control
	bits |= +event.altKey << mod.option
	bits |= +event.metaKey << mod.command
	return bits
}

// A file is treated as text whenever its content actually is text — a plain
// string (editable) or an ImmutableString (read-only). We key off the content
// shape rather than the declared mimeType, which is frequently missing or
// generic (e.g. application/octet-stream) for files that are perfectly editable
// text.
export const isTextFile = (doc: FileDoc) => {
	return typeof doc?.content === "string" || isImmutableString(doc?.content)
}

export function TextFileEditor(props: {doc: FileDoc; handle: any}) {
	let container!: HTMLDivElement

	const languageExtension = getLanguageExtension(
		props.doc.extension,
		props.doc.mimeType,
	)

	const view = new EditorView({
		doc: props.doc.content?.toString() || "",
		extensions: [
			lineNumbers(),
			highlightSpecialChars(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			highlightSelectionMatches(),
			history(),
			foldGutter(),
			bracketMatching(),
			indentUnit.of("\t"),
			EditorState.allowMultipleSelections.of(true),
			EditorState.tabSize.of(2),
			EditorView.lineWrapping,
			EditorView.clickAddsSelectionRange.of((event) => {
				const mask = modshift(event)
				if (mask == 1 << mod.option) return true
				return false
			}),
			rectangularSelection({
				eventFilter(event) {
					const mask = modshift(event)
					if (mask == ((1 << mod.shift) | (1 << mod.option)))
						return true
					return false
				},
			}),
			keymap.of([
				indentWithTab,
				...emacsStyleKeymap,
				...searchKeymap,
				...historyKeymap,
				...foldKeymap,
				...defaultKeymap,
			]),
			languageExtension,
			...codemirrorTheme,
			automergeSyncPlugin({handle: props.handle, path: ["content"]}),
		],
	})

	onCleanup(() => {
		view.destroy()
	})

	return (
		<div
			ref={(el) => {
				container = el
				el.appendChild(view.dom)
			}}
			style={{
				width: "100%",
				height: "100%",
			}}
		/>
	)
}
