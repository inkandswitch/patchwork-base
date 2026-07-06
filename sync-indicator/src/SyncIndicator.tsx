import Debug from "debug";
import * as A from "@automerge/automerge";
import {
  type DocHandle,
  type StorageId,
  type UrlHeads,
  type PeerId,
} from "@automerge/automerge-repo";
import {
  useRepo,
  RepoContext,
} from "@automerge/automerge-repo-solid-primitives";
import {
  createSignal,
  createMemo,
  createEffect,
  on,
  onCleanup,
  untrack,
  Show,
  For,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  SYNCSTATE_CHANNEL,
  type SyncStateDocMessage,
  type SyncStateBroadcast,
} from "@inkandswitch/patchwork-bootloader/types";
import { render } from "solid-js/web";
import type { ToolImplementation } from "@inkandswitch/patchwork-plugins";
import { getRelativeTimeString } from "./lib/relative-time";
import { Button, Popover, PopoverTrigger, PopoverContent } from "./lib/ui";
import { SyncIcon } from "./SyncIcon";
import { CopyIcon } from "./CopyIcon";
import "./styles.css";

const log = Debug("patchwork:sync-indicator");

declare global {
  // eslint-disable-next-line no-var
  var patchwork:
    | {
        sw?: {
          /**
           * Watch one document's sync heads. Calls `listener` on every update,
           * replaying current state on subscribe. Returns an unsubscribe fn.
           */
          subscribeSyncState?: (
            documentId: string,
            listener: (update: SyncStateDocMessage) => void
          ) => () => void;
        };
      }
    | undefined;
}

export { RepoContext };

interface PeerSyncInfo {
  id: string;
  name: string;
  storageId: StorageId | undefined;
  heads: UrlHeads | undefined;
  lastSyncTimestamp: number | undefined;
  inSync: boolean;
}

function peerName(peerId: PeerId): string {
  if (
    peerId.startsWith("shared-worker") ||
    peerId.startsWith("automerge-worker")
  )
    return "Shared Worker";
  if (peerId.startsWith("service-worker")) return "Service Worker";
  if (peerId.startsWith("storage-server")) return "Sync Server";
  return String(peerId);
}

export function SyncIndicator(props: { handle: DocHandle<unknown> }) {
  const repo = useRepo();
  const [isPopoverOpen, setIsPopoverOpen] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [ownHeads, setOwnHeads] = createSignal<UrlHeads | undefined>();

  // Global sync signals from the shared worker's @patchwork/syncstate channel.
  // `connected` is the real Subduction link to the sync server — authoritative,
  // unlike navigator.onLine which only knows the OS network is up. `serverPeerIds`
  // are the sync server's storage ids and `workerPeerId` is the shared worker's
  // id; together they let us tell the server's heads apart from the worker's own
  // (which are identical to ours) instead of guessing "unknown ⇒ server".
  const [connected, setConnected] = createSignal(false);
  const [serverPeerIds, setServerPeerIds] = createSignal<string[]>([]);
  const [workerPeerId, setWorkerPeerId] = createSignal<string | undefined>();

  // sync server state — driven by the shared worker's BroadcastChannel
  const [syncServerHeads, setSyncServerHeads] = createSignal<
    UrlHeads | undefined
  >();
  const [syncServerTimestamp, setSyncServerTimestamp] = createSignal<
    number | undefined
  >();
  const [syncServerStorageId, setSyncServerStorageId] = createSignal<
    StorageId | undefined
  >();

  // connected peers (shared worker, etc)
  const [peers, setPeers] = createStore<PeerSyncInfo[]>([]);

  // "Up to date with the sync server". The server advertises Subduction
  // *sedimentree* heads (loose-commit + fragment-boundary ids), NOT the Automerge
  // frontier, so they can't be compared to our heads with A.equals — that's why
  // the row only ever read "synced" off the (mis-attributed) worker's automerge
  // heads. Ask the handle whether we already hold everything the server
  // advertises instead, exactly like the worker's own resync check.
  const containsServerHeads = (heads: UrlHeads | undefined): boolean => {
    if (!heads || heads.length === 0) return false;
    try {
      return props.handle.containsHeads(heads);
    } catch {
      return false; // doc not ready, or an undecodable head
    }
  };

  // tick every second while popover is open (for relative times), and rebuild
  // the peer list from repo.peers each time it opens so every currently
  // connected peer shows up (the repo has no peer connect/disconnect event to
  // subscribe to, so we refresh on open rather than trying to track it live).
  createEffect(
    on(isPopoverOpen, (open) => {
      if (!open) return;
      untrack(refreshPeers);
      const interval = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(interval));
    })
  );

  // Global connection + whoami signals arrive over the worker's
  // @patchwork/syncstate BroadcastChannel (per-doc heads do NOT — those are the
  // addressed subscribeSyncState pushes below). Open it once, ask the worker to
  // replay the current snapshot, and keep our signals live.
  createEffect(() => {
    let channel: BroadcastChannel;
    try {
      channel = new BroadcastChannel(SYNCSTATE_CHANNEL);
    } catch {
      return; // no BroadcastChannel available — degrade gracefully
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as SyncStateBroadcast | undefined;
      if (!data) return;
      if (data.type === "connection") {
        setConnected(data.connected);
        setServerPeerIds(data.serverPeerIds ?? []);
      } else if (data.type === "whoami") {
        setWorkerPeerId(data.peerId);
      }
    };
    channel.addEventListener("message", onMessage);
    // Replay the current global snapshot to this freshly-opened tab.
    channel.postMessage({ type: "request" });
    onCleanup(() => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    });
  });

  /** Update sync-server signals and the "Sync Server" peer-list entry. */
  function applySyncServerUpdate(
    storageId: StorageId,
    heads: UrlHeads,
    timestamp: number
  ) {
    setSyncServerStorageId(storageId);
    setSyncServerHeads(heads);
    setSyncServerTimestamp(timestamp);

    const idx = peers.findIndex((p) => p.name === "Sync Server");
    if (idx >= 0) {
      setPeers(idx, {
        storageId,
        heads,
        lastSyncTimestamp: timestamp,
        inSync: containsServerHeads(heads),
      });
    }
  }

  // track own heads + remote heads
  createEffect(() => {
    const h = props.handle;

    setOwnHeads(h.heads());

    const onChange = () => {
      if (h.doc()) setOwnHeads(h.heads());
    };

    const onRemoteHeads = ({
      storageId,
      heads,
      timestamp,
    }: {
      storageId: StorageId;
      heads: UrlHeads;
      timestamp: number;
    }) => {
      log("remote-heads", { storageId, heads, timestamp });

      // update peer entry if it matches a known peer
      const idx = peers.findIndex((p) => p.storageId === storageId);
      if (idx >= 0) {
        const currentHeads = ownHeads();
        setPeers(idx, {
          heads,
          lastSyncTimestamp: timestamp,
          inSync: currentHeads ? A.equals(currentHeads, heads) : false,
        });
      }
    };

    h.on("change", onChange);
    h.on("remote-heads", onRemoteHeads);

    // Update one repo-peer row (another tab, storage server): those advertise
    // Automerge frontier heads, so A.equals is the right "in sync" test here.
    const updatePeerRow = (idx: number, heads: UrlHeads, timestamp: number) => {
      const currentHeads = ownHeads();
      setPeers(idx, {
        heads,
        lastSyncTimestamp: timestamp,
        inSync: currentHeads ? A.equals(currentHeads, heads) : false,
      });
    };

    // Subscribe to this doc's sync heads from the automerge worker. It replays
    // the current state on subscribe and pushes every update, keyed by the
    // sender's storage id. Attribute each update by *who* sent it, using the
    // identities the worker announces on the syncstate channel — NEVER "unknown
    // ⇒ must be the server", which funnels the worker's OWN heads (identical to
    // ours) into the server row so it looks perpetually "synced".
    const onSyncState = (update: SyncStateDocMessage) => {
      if (update.documentId !== h.documentId) return;
      log("sync-state", update);

      const heads = update.heads as UrlHeads;
      const sid = update.storageId;

      // The real sync server (definitive: it told us its ids over `connection`).
      if (serverPeerIds().includes(sid)) {
        applySyncServerUpdate(sid as StorageId, heads, update.timestamp);
        return;
      }
      // The shared worker's own heads (keyed by its whoami peerId). Its row is
      // hidden outside debug; update it if present, otherwise ignore — it must
      // never fall through to the sync-server slot.
      if (workerPeerId() && sid === workerPeerId()) {
        const idx = peers.findIndex((p) => p.storageId === sid);
        if (idx >= 0) updatePeerRow(idx, heads, update.timestamp);
        return;
      }
      // A known repo peer, matched by storage id.
      const idx = peers.findIndex((p) => p.storageId === sid);
      if (idx >= 0) {
        updatePeerRow(idx, heads, update.timestamp);
        return;
      }
      // Unknown sender that isn't the worker: once whoami has arrived the only
      // remaining Subduction sender is the sync server, so attribute it there.
      // Before whoami lands, drop it rather than risk mislabeling worker heads.
      if (workerPeerId()) {
        applySyncServerUpdate(sid as StorageId, heads, update.timestamp);
      }
    };

    const unsubscribeSyncState =
      globalThis?.patchwork?.sw?.subscribeSyncState?.(
        h.documentId,
        onSyncState
      );

    // Build the initial peer list. refreshPeers() reads the syncServer* signals,
    // and onSyncState *writes* them on every update — so tracking those reads
    // here would make this effect re-run (tearing down and re-subscribing, which
    // makes the worker replay) on every single sync-state message: a feedback
    // loop that floods messages, flickers the peer list, and kills the shared
    // worker. untrack keeps this effect depending on props.handle alone.
    untrack(refreshPeers);

    onCleanup(() => {
      h.off("change", onChange);
      h.off("remote-heads", onRemoteHeads);
      unsubscribeSyncState?.();
    });
  });

  function refreshPeers() {
    const h = props.handle;
    const currentHeads = h.heads();
    const peerList: PeerSyncInfo[] = repo.peers.map((peerId) => {
      const storageId = repo.getStorageIdOfPeer(peerId);
      const syncInfo = storageId ? h.getSyncInfo(storageId) : undefined;
      return {
        id: peerId,
        name: peerName(peerId),
        storageId,
        heads: syncInfo?.lastHeads,
        lastSyncTimestamp: syncInfo?.lastSyncTimestamp,
        inSync:
          syncInfo?.lastHeads && currentHeads
            ? A.equals(currentHeads, syncInfo.lastHeads)
            : false,
      };
    });

    // Always add sync server as a virtual peer — the main thread
    // doesn't talk to it directly; its state comes from the shared
    // worker's @patchwork/syncstate BroadcastChannel / IndexedDB.
    {
      const serverHeads = syncServerHeads();
      const serverTs = syncServerTimestamp();
      peerList.push({
        id: "sync-server",
        name: "Sync Server",
        storageId: syncServerStorageId(),
        heads: serverHeads,
        lastSyncTimestamp: serverTs,
        // sedimentree heads — use containsHeads, not A.equals (see helper).
        inSync: containsServerHeads(serverHeads),
      });
    }

    // sort: shared worker first, sync server last
    const peerOrder = (p: PeerSyncInfo) =>
      p.name === "Shared Worker" ? 0 : p.name === "Sync Server" ? 2 : 1;
    peerList.sort((a, b) => peerOrder(a) - peerOrder(b));

    log("peers", peerList);
    // Show every connected peer, including our own shared worker — the icon
    // stays driven by the sync server (see syncedToServer), but the popover is
    // a full readout of who we're talking to.
    setPeers(reconcile(peerList));
  }

  // recompute inSync when own heads change
  createEffect(() => {
    const currentHeads = ownHeads();
    if (!currentHeads) return;
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      // The sync server advertises sedimentree heads → containsHeads, not
      // A.equals (which is right for automerge-frontier peers).
      const inSync =
        peer.name === "Sync Server"
          ? containsServerHeads(peer.heads)
          : peer.heads
            ? A.equals(currentHeads, peer.heads)
            : false;
      if (peer.inSync !== inSync) {
        setPeers(i, "inSync", inSync);
      }
    }
  });

  // Single source of truth for "are we up to date with the sync server". Both
  // the icon AND the Sync Server row read this one memo. Previously the icon
  // derived it live (`containsServerHeads`) while the row rendered a separately
  // stored `peer.inSync` snapshot, set on a different code path — so a fast
  // burst of edits could settle with the two disagreeing (icon still "syncing"
  // while the row already said "synced"). One memo, read in both places, can't
  // diverge.
  const syncedToServer = createMemo(() => {
    ownHeads(); // re-evaluate when our heads move (containsHeads reads the doc)
    return containsServerHeads(syncServerHeads());
  });

  const syncServerKnown = () => !!syncServerHeads();

  // Status label for one peer row. The Sync Server row reflects `syncedToServer`
  // (the same memo the icon uses); everyone else compares stored heads.
  const peerStatusLabel = (peer: PeerSyncInfo) => {
    const inSync = peer.name === "Sync Server" ? syncedToServer() : peer.inSync;
    return inSync ? "synced" : peer.heads ? "behind" : "unknown";
  };

  const iconState = (): "synced" | "syncing" | "error" | "unknown" => {
    if (!connected()) return "error"; // no live link to the sync server
    if (!syncServerKnown()) return "unknown";
    return syncedToServer() ? "synced" : "syncing";
  };

  const statusText = () => {
    if (!connected()) return "Offline";
    if (!syncServerKnown()) return "Connecting…";
    return syncedToServer() ? "Synced to server" : "Syncing…";
  };

  const onCopy = async () => {
    const data = {
      ownHeads: ownHeads(),
      syncServer: {
        storageId: syncServerStorageId(),
        heads: syncServerHeads(),
        lastSyncTimestamp: syncServerTimestamp(),
        inSync: syncedToServer(),
      },
      peers: peers.map((p) => ({
        name: p.name,
        id: p.id,
        storageId: p.storageId,
        heads: p.heads,
        lastSyncTimestamp: p.lastSyncTimestamp,
        inSync: p.inSync,
      })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      log("copied sync state to clipboard", data);
    } catch (err) {
      log("failed to copy sync state:", err);
    }
  };

  const relativeTime = (ts: number | undefined) => {
    void now();
    return ts ? getRelativeTimeString(ts) : "-";
  };

  const copyHeads = async (heads: UrlHeads | undefined) => {
    if (!heads) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(heads));
    } catch (err) {
      log("failed to copy heads:", err);
    }
  };

  return (
    <Popover open={isPopoverOpen()} onOpenChange={setIsPopoverOpen}>
      <PopoverTrigger
        class={connected() ? "sync-trigger" : "sync-trigger-offline"}
      >
        <SyncIcon size={20} state={iconState()} />
      </PopoverTrigger>
      <PopoverContent>
        <div class="sync-popover-body">
          <div class="sync-status-header">{statusText()}</div>

          <div class="sync-peers">
            <div
              class="sync-peer sync-peer-clickable"
              onClick={() => copyHeads(ownHeads())}
            >
              <div class="sync-peer-header">
                <span class="sync-peer-name">Tab</span>
              </div>
              <div class="sync-peer-detail">
                heads:{" "}
                {JSON.stringify((ownHeads() ?? []).map((h) => h.slice(0, 6)))}
              </div>
            </div>

            <For each={peers}>
              {(peer) => (
                <>
                  <div
                    class="sync-peer sync-peer-clickable"
                    onClick={() => copyHeads(peer.heads)}
                  >
                    <div class="sync-peer-header">
                      <span class="sync-peer-name">{peer.name}</span>
                      <span class="sync-peer-status">
                        {peerStatusLabel(peer)}
                      </span>
                    </div>
                    <Show when={peer.heads}>
                      <div class="sync-peer-detail">
                        heads:{" "}
                        {JSON.stringify(peer.heads!.map((h) => h.slice(0, 6)))}
                      </div>
                    </Show>
                    <Show when={peer.lastSyncTimestamp}>
                      <div class="sync-peer-detail">
                        {relativeTime(peer.lastSyncTimestamp)}
                      </div>
                    </Show>
                  </div>
                </>
              )}
            </For>
          </div>

          <div class="sync-footer">
            <Button onClick={onCopy}>
              <CopyIcon size={14} />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export const renderSyncIndicator: ToolImplementation = (handle, element) => {
  element.style.width = "fit-content";
  element.style.zIndex = "10";

  const dispose = render(
    () => (
      <RepoContext.Provider value={element.repo}>
        <SyncIndicator handle={handle} />
      </RepoContext.Provider>
    ),
    element
  );
  return () => dispose();
};
