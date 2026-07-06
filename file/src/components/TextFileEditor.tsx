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
import {EditorState, Compartment} from "@codemirror/state"
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

// Extensions that get in-browser TypeScript LSP features (completions, hovers,
// diagnostics), mapped to the virtual file path handed to the TS environment.
// The path's final extension tells TypeScript how to parse the file, so .mts/
// .cts collapse to .ts and .mjs/.cjs to .js.
const TS_LSP_PATHS: Record<string, string> = {
	js: "/index.js",
	mjs: "/index.js",
	cjs: "/index.js",
	jsx: "/index.jsx",
	ts: "/index.ts",
	mts: "/index.ts",
	cts: "/index.ts",
	tsx: "/index.tsx",
}

const tsLspPath = (extension?: string): string | undefined => {
	if (!extension) return undefined
	const ext = extension.startsWith(".") ? extension.slice(1) : extension
	return TS_LSP_PATHS[ext.toLowerCase()]
}

export function TextFileEditor(props: {doc: FileDoc; handle: any}) {
	let container!: HTMLDivElement

	const languageExtension = getLanguageExtension(
		props.doc.extension,
		props.doc.mimeType,
	)

	// TypeScript LSP features are reconfigured into this compartment once the
	// (asynchronously loaded) TS environment is ready — see below.
	const tsCompartment = new Compartment()

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
			tsCompartment.of([]),
			...codemirrorTheme,
			automergeSyncPlugin({handle: props.handle, path: ["content"]}),
		],
	})

	// For JS/TS files, spin up an in-browser TypeScript environment and graft on
	// LSP features (completions, hovers, inline diagnostics). The environment —
	// and the TypeScript compiler it needs — is imported dynamically so it only
	// loads when a code file is opened, then reconfigured into the compartment in
	// place. Guard against the editor being torn down before it resolves.
	const lspPath = tsLspPath(props.doc.extension)
	if (lspPath) {
		let disposed = false
		onCleanup(() => {
			disposed = true
		})
		void (async () => {
			try {
				const [
					{createTsEnv},
					{tsFacet, tsSync, tsLinter, tsAutocomplete, tsHover},
					{autocompletion},
				] = await Promise.all([
					import("../ts-env"),
					import("@valtown/codemirror-ts"),
					import("@codemirror/autocomplete"),
				])
				const env = await createTsEnv(lspPath, view.state.doc.toString())
				if (disposed) return
				view.dispatch({
					effects: tsCompartment.reconfigure([
						tsFacet.of({env, path: lspPath}),
						tsSync(),
						tsLinter(),
						autocompletion({override: [tsAutocomplete()]}),
						tsHover(),
					]),
				})
			} catch (error) {
				// LSP is an enhancement — a failure here (e.g. offline with no cached
				// lib.d.ts) leaves a perfectly usable plain editor.
				console.error("failed to start TypeScript LSP", error)
			}
		})()
	}

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
