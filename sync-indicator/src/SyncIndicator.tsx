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
import { createSignal, createEffect, on, onCleanup, Show, For } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { getRelativeTimeString } from "./lib/relative-time";
import { Button, Popover, PopoverTrigger, PopoverContent } from "./lib/ui";
import { SyncIcon } from "./SyncIcon";
import { CopyIcon } from "./CopyIcon";
import "./styles.css";

const log = Debug("patchwork:sync-indicator");

/**
 * Worker → tab: one peer's heads for a subscribed document — the worker's own
 * or a Subduction peer's, keyed by its storageId. Mirrors the bootloader's
 * `SyncStateDocMessage`; delivered via `patchwork.sw.subscribeSyncState`.
 */
interface SyncStateUpdate {
  type: "sync-state";
  documentId: string;
  storageId: string;
  heads: string[];
  timestamp: number;
}

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
            listener: (update: SyncStateUpdate) => void,
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
  const [isOnline, setIsOnline] = createSignal(navigator.onLine);

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

  // tick every second while popover is open (for relative times)
  createEffect(
    on(isPopoverOpen, (open) => {
      if (!open) return;
      const interval = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(interval));
    })
  );

  // online/offline
  {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    onCleanup(() => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    });
  }

  /** Update sync-server signals and the matching peer-list entry. */
  function applySyncServerUpdate(
    storageId: StorageId,
    heads: UrlHeads,
    timestamp: number,
  ) {
    setSyncServerStorageId(storageId);
    setSyncServerHeads(heads);
    setSyncServerTimestamp(timestamp);

    const idx = peers.findIndex((p) => p.name === "Sync Server");
    if (idx >= 0) {
      const currentHeads = ownHeads();
      setPeers(idx, {
        storageId,
        heads,
        lastSyncTimestamp: timestamp,
        inSync: currentHeads ? A.equals(currentHeads, heads) : false,
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

    // Subscribe to this doc's sync heads from the automerge worker. It replays
    // the current state on subscribe and pushes every update, keyed by peer
    // storageId, so there's no need to seed from IndexedDB or listen on a
    // broadcast channel. Updates for a known peer refresh that peer's row;
    // anything else (the sync server, which the tab doesn't talk to directly)
    // drives the sync-server slot.
    const onSyncState = (update: SyncStateUpdate) => {
      if (update.documentId !== h.documentId) return;
      log("sync-state", update);

      const heads = update.heads as UrlHeads;
      const idx = peers.findIndex((p) => p.storageId === update.storageId);
      if (idx >= 0) {
        const currentHeads = ownHeads();
        setPeers(idx, {
          heads,
          lastSyncTimestamp: update.timestamp,
          inSync: currentHeads ? A.equals(currentHeads, heads) : false,
        });
      } else {
        applySyncServerUpdate(
          update.storageId as StorageId,
          heads,
          update.timestamp,
        );
      }
    };

    const unsubscribeSyncState = globalThis?.patchwork?.sw?.subscribeSyncState?.(
      h.documentId,
      onSyncState,
    );

    // build initial peer list
    refreshPeers();

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
        inSync:
          serverHeads && currentHeads
            ? A.equals(currentHeads, serverHeads)
            : false,
      });
    }

    // sort: shared worker first, sync server last
    const peerOrder = (p: PeerSyncInfo) =>
      p.name === "Shared Worker" ? 0 : p.name === "Sync Server" ? 2 : 1;
    peerList.sort((a, b) => peerOrder(a) - peerOrder(b));
    let p = peerList;

    log("peers", peerList);
    if (!localStorage.debug && !localStorage.DEBUG) {
      p = p.filter((p) => p.name != "Shared Worker");
    }
    setPeers(reconcile(p));
  }

  // recompute inSync when own heads change
  createEffect(() => {
    const currentHeads = ownHeads();
    if (!currentHeads) return;
    for (let i = 0; i < peers.length; i++) {
      const peerHeads = peers[i].heads;
      const inSync = peerHeads ? A.equals(currentHeads, peerHeads) : false;
      if (peers[i].inSync !== inSync) {
        setPeers(i, "inSync", inSync);
      }
    }
  });

  // the icon is driven by sync server state specifically
  const syncServerInSync = () => {
    const server = syncServerHeads();
    const own = ownHeads();
    if (!server || !own) return false;
    return A.equals(own, server);
  };

  const syncServerKnown = () => !!syncServerHeads();

  const iconState = (): "synced" | "syncing" | "error" | "unknown" => {
    if (!isOnline()) return syncServerInSync() ? "synced" : "error";
    if (!syncServerKnown()) return "unknown";
    return syncServerInSync() ? "synced" : "syncing";
  };

  const statusText = () => {
    if (!isOnline()) return "Offline";
    if (syncServerInSync()) return "Synced to server";
    if (syncServerHeads()) return "Syncing...";
    return "Sync server status unknown";
  };

  const onCopy = async () => {
    const data = {
      ownHeads: ownHeads(),
      syncServer: {
        storageId: syncServerStorageId(),
        heads: syncServerHeads(),
        lastSyncTimestamp: syncServerTimestamp(),
        inSync: syncServerInSync(),
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
        class={isOnline() ? "sync-trigger" : "sync-trigger-offline"}
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
                        {peer.inSync
                          ? "synced"
                          : peer.heads
                            ? "behind"
                            : "unknown"}
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
