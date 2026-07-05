// The `chat:autocomplete` extension seam. AutocompletePopup hardcodes the built-in
// triggers (`/` slash, `@` mention, `:` emoji); this lets a plugin contribute
// extra items for a trigger without touching the popup. Resolved like the other
// function-valued plugin types (chat:slash etc.) through `createLoadedPlugins`, so
// a cross-bundle contribution rides behind `async load()` while built-ins are used
// inline.
//
// A provider is built once per popup via `create(ctx)` — that's where it may set
// up reactive state (e.g. a live selection accessor) — and the returned function
// is called on each keystroke with the active trigger and query.
import type {Accessor} from "solid-js"
import type {Repo} from "@automerge/automerge-repo"
import type {PluginSelector} from "./registry"
import type {AutocompleteItem} from "../components/AutocompletePopup"
import {selectionAutocomplete} from "../features/selection-mention"

export interface AutocompleteCtx {
	element: HTMLElement
	repo: Repo
	selector: Accessor<PluginSelector>
}

export type AutocompleteProvider = (input: {
	trigger: "@" | "/" | ":"
	query: string
}) => AutocompleteItem[]

export interface AutocompletePlugin {
	type: "chat:autocomplete"
	id: string
	tier: "core" | "full"
	create: (ctx: AutocompleteCtx) => AutocompleteProvider
}

// Built-in providers (merged with host-registered ones by createLoadedPlugins).
export const autocompletePlugins: AutocompletePlugin[] = [selectionAutocomplete]
