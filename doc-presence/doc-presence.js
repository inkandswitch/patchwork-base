import {render} from "solid-js/web"
import html from "solid-js/html"
import {createSignal} from "solid-js"
import {automergeUrlToServiceWorkerUrl} from "@inkandswitch/patchwork-filesystem"
import {subscribe} from "@inkandswitch/patchwork-providers"

const HEARTBEAT_MS = 1_000
const STALE_MS = 5_000

// ── Presence manager (module-level) ──

const [selfInfo, setSelfInfo] = createSignal(null)
const [focused, setFocused] = createSignal(document.hasFocus())

let myContactUrl = null
const sessions = new Map()
let currentDocUrl = null
let unsubscribeView = null

let loadingSelf = null
function loadSelf() {
	if (!loadingSelf) loadingSelf = loadSelfOnce()
	return loadingSelf
}

async function loadSelfOnce() {
	let contactUrl
	while (!(contactUrl = window.accountDocHandle?.doc()?.contactUrl)) {
		await new Promise(resolve => setTimeout(resolve, 250))
	}
	myContactUrl = contactUrl
	const contactHandle = await window.repo.find(myContactUrl)
	function refresh() {
		const c = contactHandle.doc()
		if (!c) return
		setSelfInfo({
			name: c.type === "registered" ? c.name : "Anonymous",
			color: c.color || null,
			avatarUrl: (c.type === "registered" && c.avatarUrl) || null,
		})
	}
	refresh()
	contactHandle.on("change", refresh)
}

function broadcast(handle) {
	const s = selfInfo()
	if (!myContactUrl || !s) return
	handle.broadcast({
		type: "doc-presence",
		contactUrl: myContactUrl,
		name: s.name,
		color: s.color,
		avatarUrl: s.avatarUrl,
		focused: focused(),
	})
}

function sendGoodbye(handle) {
	if (!myContactUrl) return
	handle.broadcast({
		type: "doc-presence-goodbye",
		contactUrl: myContactUrl,
	})
}

function joinDoc(handle) {
	const url = handle.url
	if (sessions.has(url)) return sessions.get(url)

	const [peers, setPeers] = createSignal(new Map(), {equals: false})

	function onMessage({message: msg}) {
		if (!msg || msg.contactUrl === myContactUrl) return
		if (msg.type === "doc-presence-goodbye") {
			setPeers(m => {
				m.delete(msg.contactUrl)
				return m
			})
			return
		}
		if (msg.type !== "doc-presence") return
		setPeers(m => {
			m.set(msg.contactUrl, {...msg, ts: Date.now()})
			return m
		})
	}

	function prune() {
		const now = Date.now()
		setPeers(m => {
			for (const [k, v] of m) {
				if (now - v.ts > STALE_MS) m.delete(k)
			}
			return m
		})
	}

	handle.on("ephemeral-message", onMessage)
	broadcast(handle)
	const interval = setInterval(() => {
		broadcast(handle)
		prune()
	}, HEARTBEAT_MS)

	const session = {handle, peers, interval, onMessage}
	sessions.set(url, session)
	return session
}

function leaveDoc(handle) {
	const url = handle.url
	const session = sessions.get(url)
	if (!session) return
	sendGoodbye(handle)
	clearInterval(session.interval)
	handle.off("ephemeral-message", session.onMessage)
	sessions.delete(url)
}

window.addEventListener("focus", () => {
	setFocused(true)
	for (const s of sessions.values()) broadcast(s.handle)
})
window.addEventListener("blur", () => {
	setFocused(false)
	for (const s of sessions.values()) broadcast(s.handle)
})
window.addEventListener("beforeunload", () => {
	for (const s of sessions.values()) sendGoodbye(s.handle)
})

// ── Track selected doc via SelectedDocProvider ──

async function onSelectedDocChange(newUrl) {
	if (newUrl === currentDocUrl) return

	if (currentDocUrl) {
		const old = sessions.get(currentDocUrl)
		if (old) leaveDoc(old.handle)
	}

	currentDocUrl = newUrl

	if (newUrl && window.repo) {
		loadSelf()
		const handle = await window.repo.find(newUrl)
		joinDoc(handle)
	}
}

function connectToSelectedDocProvider(element) {
	if (unsubscribeView) return
	unsubscribeView = subscribe(element, {type: "patchwork:selected-view"}, view => {
		onSelectedDocChange(view?.url)
	})
}

loadSelf()

// ── Tool (rendering only) ──

function DocPresence(handle, element) {
	connectToSelectedDocProvider(element)
	const session = joinDoc(handle)

	function face(entry, fadedFn) {
		const color = entry.color || "#888"
		const initial = (entry.name || "?")[0].toUpperCase()
		const imgUrl = entry.avatarUrl
			? automergeUrlToServiceWorkerUrl(entry.avatarUrl)
			: null
		return html`<div
			class="doc-presence-face"
			style=${() => {
				let s = `--face-color:${color}; opacity:${fadedFn() ? 0.35 : 1};`
				if (imgUrl)
					s += ` background-image: url("${imgUrl}"); color: transparent;`
				return s
			}}
			title=${entry.name}
		>
			${initial}
		</div>`
	}

	const style = document.createElement("style")
	style.textContent = `
		.doc-presence {
			display: flex;
			align-items: center;
			gap: 2px;
			height: 100%;
		}
		.doc-presence-face {
			width: 22px;
			height: 22px;
			border-radius: 50%;
			border: 2px solid var(--face-color, #888);
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 10px;
			font-weight: 600;
			line-height: 1;
			overflow: hidden;
			flex-shrink: 0;
			transition: opacity 0.3s ease;
			background-color: var(--color-base-200, #eee);
			background-size: cover;
			background-position: center;
			color: var(--color-base-content, #333);
		}
	`
	element.appendChild(style)

	const dispose = render(
		() => html`<div class="doc-presence">
			${() => {
				const s = selfInfo()
				if (!s) return null
				return face(s, () => !focused())
			}}
			${() =>
				[...session.peers().values()].map(p => face(p, () => !p.focused))}
		</div>`,
		element,
	)

	return () => {
		leaveDoc(handle)
		style.remove()
		dispose()
	}
}

export const plugins = [
	{
		type: "patchwork:tool",
		id: "doc-presence",
		tags: ["titlebar-tool"],
		name: "Presence",
		icon: "Users",
		supportedDatatypes: "*",
		forTitleBar: true,
		unlisted: true,
		async load() {
			return DocPresence
		},
	},
]
