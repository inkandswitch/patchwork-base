import "./styles.css"
import type {DocHandle} from "@automerge/automerge-repo"
import {
	getRegistry,
	type ToolDescription,
	type ToolElement,
	type ToolImplementation,
} from "@inkandswitch/patchwork-plugins"
import type {TinyPatchworkLayoutDoc} from "./types"

export function renderContextSidebar(
	handle: DocHandle<TinyPatchworkLayoutDoc>,
	element: ToolElement
): () => void {
	let selectedToolIndex = 0
	const cleanups: (() => void)[] = []
	const toolRegistry = getRegistry<ToolDescription, ToolImplementation>(
		"patchwork:tool"
	)

	const container = document.createElement("div")
	container.className = "w-full h-full flex flex-col bg-base-300 context-sidebar"
	element.appendChild(container)

	const tabBar = document.createElement("div")
	tabBar.className = "flex place-content-center place-items-start"
	container.appendChild(tabBar)

	const tabList = document.createElement("div")
	tabList.role = "tablist"
	tabList.className = "tabs tabs-lifted flex-1"
	tabBar.appendChild(tabList)

	const closeButton = document.createElement("button")
	closeButton.className = "sidebar-close-button"
	closeButton.title = "Close context sidebar"
	closeButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></svg>`
	closeButton.addEventListener("click", closeSidebar)
	tabBar.appendChild(closeButton)

	const content = document.createElement("div")
	content.className = "flex-1 bg-base-300 min-h-0 overflow-auto"
	container.appendChild(content)

	function closeSidebar() {
		let root: Document | ShadowRoot =
			element instanceof ShadowRoot
				? element
				: (element.getRootNode() as Document | ShadowRoot)
		if (root instanceof ShadowRoot) {
			root = root.host.getRootNode() as Document | ShadowRoot
		}
		const toggles = root.querySelectorAll(".sidebar-toggle")
		;(toggles[toggles.length - 1] as HTMLElement)?.click()
	}

	let currentToolId: string | undefined

	function renderTabs(toolIds: string[]) {
		tabList.replaceChildren()
		for (let i = 0; i < toolIds.length; i++) {
			const tool = toolRegistry.get(toolIds[i])
			if (!tool) continue

			const tab = document.createElement("a")
			tab.role = "tab"
			tab.className = `tab ${i === selectedToolIndex ? "tab-active" : ""}`
			const index = i
			tab.addEventListener("click", () => {
				selectedToolIndex = index
				render()
			})

			const name = document.createElement("span")
			name.className = "text-sm"
			name.textContent = tool.name
			tab.appendChild(name)
			tabList.appendChild(tab)
		}
	}

	function renderContent(toolId: string | undefined) {
		if (toolId === currentToolId) return
		currentToolId = toolId

		content.replaceChildren()
		if (toolId != null) {
			const view = document.createElement("patchwork-view")
			view.setAttribute("doc-url", handle.url)
			view.setAttribute("tool-id", toolId)
			content.appendChild(view)
		}
	}

	function render() {
		const doc = handle.doc()
		if (!doc) return

		const toolIds = doc.contextToolIds
		renderTabs(toolIds)
		renderContent(toolIds[selectedToolIndex])
	}

	render()

	handle.on("change", render)
	cleanups.push(() => handle.off("change", render))

	const unsubToolChanges = toolRegistry.on("changed", render)
	cleanups.push(unsubToolChanges)

	return () => {
		cleanups.forEach(fn => fn())
		container.remove()
	}
}
