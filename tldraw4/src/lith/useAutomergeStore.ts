import {
  type TLAnyShapeUtilConstructor,
  type TLRecord,
  type TLStoreWithStatus,
  createTLStore,
  defaultShapeUtils,
  type HistoryEntry,
  getUserPreferences,
  setUserPreferences,
  defaultUserPreferences,
  createPresenceStateDerivation,
  InstancePresenceRecordType,
  computed,
  react,
  type TLStoreSnapshot,
  sortById,
} from "@tldraw/tldraw";
import { useEffect, useState } from "react";
import {
  type DocHandle,
  type DocHandleChangePayload,
} from "@automerge/automerge-repo";
import {
  useLocalAwareness,
  useRemoteAwareness,
} from "@automerge/automerge-repo-react-hooks";

import { applyAutomergePatchesToTLStore } from "./AutomergeToTLStore.js";
import { applyTLStoreChangesToAutomerge } from "./TLStoreToAutomerge.js";

export function useAutomergeStore({
  handle,
  shapeUtils = [],
  readOnly = false,
}: {
  handle: DocHandle<TLStoreSnapshot>;
  userId: string;
  shapeUtils?: TLAnyShapeUtilConstructor[];
  readOnly?: boolean;
}): TLStoreWithStatus {
  const [store] = useState(() => {
    const store = createTLStore({
      shapeUtils: [...defaultShapeUtils, ...shapeUtils],
    });
    return store;
  });

  const [storeWithStatus, setStoreWithStatus] = useState<TLStoreWithStatus>({
    status: "loading",
  });

  /* -------------------- TLDraw <--> Automerge -------------------- */
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    // A hacky workaround to prevent local changes from being applied twice
    // once into the automerge doc and then back again.
    let preventPatchApplications = false;

    /* TLDraw to Automerge */
    function syncStoreChangesToAutomergeDoc({
      changes,
    }: HistoryEntry<TLRecord>) {
      preventPatchApplications = true;
      handle.change((doc) => {
        applyTLStoreChangesToAutomerge(doc, changes);
      });
      preventPatchApplications = false;
    }

    // A read-only (history-pinned) handle is at fixed heads and rejects
    // `handle.change`, so never forward store edits back to Automerge.
    if (!readOnly) {
      unsubs.push(
        store.listen(syncStoreChangesToAutomergeDoc, {
          source: "user",
          scope: "document",
        })
      );
    }

    /* Automerge to TLDraw */
    const syncAutomergeDocChangesToStore = ({
      patches,
      scopeReplaced,
    }: DocHandleChangePayload<any>) => {
      if (preventPatchApplications) return;

      // A wholesale scope replacement (e.g. the draft overlay re-pointing
      // this handle at a different clone) carries no patch stream connecting
      // the old doc to the new one. Diff the new doc's *document*-scope
      // records into the store rather than `loadStoreSnapshot`: that would
      // `clear()` the session-scope records too (camera/zoom, current page,
      // selection), which should survive a draft switch. Drafts are forks of
      // each other, so most records are identical and `put` skips them.
      if (scopeReplaced) {
        const doc = handle.doc();
        if (!doc?.store) return;
        const migrated = store.schema.migrateStoreSnapshot({
          store: JSON.parse(JSON.stringify(doc.store)),
          schema: JSON.parse(JSON.stringify(doc.schema)),
        });
        if (migrated.type === "error") {
          console.error(
            "[tldraw4] failed to migrate swapped-in snapshot:",
            migrated.reason
          );
          return;
        }
        const next = migrated.value;
        store.mergeRemoteChanges(() => {
          const toRemove = store
            .allRecords()
            .filter(
              (record) =>
                store.scopedTypes.document.has(record.typeName) &&
                !(record.id in next)
            )
            .map((record) => record.id);
          if (toRemove.length) store.remove(toRemove);
          store.put(Object.values(next));
        });
        return;
      }

      applyAutomergePatchesToTLStore(patches, store);
    };

    handle.on("change", syncAutomergeDocChangesToStore);
    unsubs.push(() => handle.off("change", syncAutomergeDocChangesToStore));

    /* Load the initial document snapshot into the store. */
    // TODO: need to think through the various status possibilities here and how they map
    const doc = handle.doc();
    if (!doc) throw new Error("Document not found");
    if (!doc.store) throw new Error("Document store not initialized");

    store.mergeRemoteChanges(() => {
      store.loadStoreSnapshot({
        store: JSON.parse(JSON.stringify(doc.store)),
        schema: JSON.parse(JSON.stringify(doc.schema)),
      });
    });

    setStoreWithStatus({
      store,
      status: "synced-remote",
      connectionStatus: "online",
    });

    return () => {
      unsubs.forEach((fn) => fn());
      unsubs.length = 0;
    };
  }, [handle, store, readOnly]);

  return storeWithStatus;
}

export function useAutomergePresence({
  handle,
  store,
  userMetadata,
}: {
  handle: DocHandle<TLStoreSnapshot>;
  store: TLStoreWithStatus;
  userMetadata: any;
}) {
  const innerStore = store?.store;

  const { userId, name, color } = userMetadata;

  const [, updateLocalState] = useLocalAwareness({
    handle,
    userId,
    initialState: {},
  });

  const [peerStates] = useRemoteAwareness({
    handle,
    localUserId: userId,
  });

  /* ----------- Presence stuff ----------- */
  useEffect(() => {
    if (!innerStore) return;

    const toPut: TLRecord[] = Object.values(peerStates).filter(
      (record) => record && Object.keys(record).length !== 0
    );

    // put / remove the records in the store
    const toRemove = innerStore.query
      .records("instance_presence")
      .get()
      .sort(sortById)
      .map((record) => record.id)
      .filter((id) => !toPut.find((record) => record.id === id));

    if (toRemove.length) innerStore.remove(toRemove);
    if (toPut.length) innerStore.put(toPut);
  }, [innerStore, peerStates]);

  useEffect(() => {
    if (!innerStore) return;
    /* ----------- Presence stuff ----------- */
    setUserPreferences({ id: userId, color, name });

    const userPreferences = computed<{
      id: string;
      color: string;
      name: string;
    }>("userPreferences", () => {
      const user = getUserPreferences();
      return {
        id: user.id,
        color: user.color ?? defaultUserPreferences.color,
        name: user.name ?? defaultUserPreferences.name,
      };
    });

    const presenceId = InstancePresenceRecordType.createId(userId);
    const presenceDerivation = createPresenceStateDerivation(
      userPreferences,
      presenceId
    )(innerStore);

    return react("when presence changes", () => {
      const presence = presenceDerivation.get();
      requestAnimationFrame(() => {
        updateLocalState(presence);
      });
    });
  }, [innerStore, userId, updateLocalState]);
  /* ----------- End presence stuff ----------- */
}
