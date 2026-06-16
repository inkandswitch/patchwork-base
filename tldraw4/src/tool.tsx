import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";
import { decodeHeads, type UrlHeads } from "@automerge/automerge-repo";
import {
  RepoContext,
  useDocHandle,
  useDocument,
  useRepo,
} from "@automerge/react";
import {
  Tldraw,
  useEditor,
  getMediaAssetInfoPartial,
  atom,
  type VecLike,
  type TLContent,
  type TLAssetId,
  type TLAsset,
  type TLComponents,
  type TLRecord,
  type TLShapeId,
  type TLStoreWithStatus,
} from "@tldraw/tldraw";
import {
  useAutomergeStore,
  useAutomergePresence,
} from "./lith/useAutomergeStore.ts";
import type { TLDrawDoc } from "./datatype.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnixFileEntry } from "@inkandswitch/patchwork-filesystem";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";
import { useSubscribe } from "@inkandswitch/patchwork-providers-react";
import { createRoot } from "react-dom/client";
import { diffStore, type ShapeDiff } from "./diff.ts";
import {
  DiffShapeWrapper,
  DiffStatusContext,
  type DiffStatus,
  type DiffStatusAtom,
} from "./DiffShapeWrapper.tsx";

// Diff baseline (fork-point heads) served by the draft overlay
// (`patchwork:baseline`). `heads` is `null` when there is no baseline and no
// diff is rendered (e.g. on "main"). It is `null` rather than optional so the
// value is a valid structured-cloneable `JSONValue` crossing the provider
// channel.
type Baseline = { heads: UrlHeads | null };

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

function extensionForMimeType(mimeType: string): string {
  return MIME_TO_EXT[mimeType] || mimeType.split("/")[1] || "bin";
}

interface ContactDoc {
  type: string;
  name?: string;
  color?: string;
}

function useContactInfo() {
  const [contactUrl, setContactUrl] = useState<AutomergeUrl | undefined>();

  useEffect(() => {
    const accountDocHandle = (window as any).accountDocHandle as
      | DocHandle<{ contactUrl: AutomergeUrl }>
      | undefined;
    if (!accountDocHandle) return;
    accountDocHandle.whenReady().then(() => {
      const doc = accountDocHandle.doc();
      if (doc?.contactUrl) {
        setContactUrl(doc.contactUrl);
      }
    });
  }, []);

  const [contactDoc] = useDocument<ContactDoc>(contactUrl);

  return {
    userId: contactUrl ?? (window as any).repo?.peerId ?? "anonymous",
    name: contactDoc?.name ?? "Anonymous",
    color: contactDoc?.color,
  };
}

export function TldrawTool({
  docUrl,
  element,
}: {
  docUrl: AutomergeUrl;
  element: HTMLElement;
}) {
  const handle = useDocHandle<TLDrawDoc>(docUrl, { suspense: true });
  const contactInfo = useContactInfo();
  const store = useAutomergeStore({ handle, userId: contactInfo.userId });

  useAutomergePresence({
    handle: handle as DocHandle<any>,
    store,
    userMetadata: contactInfo,
  });

  const baseline = useSubscribe<Baseline>(
    element,
    { type: "patchwork:baseline", url: docUrl },
    { heads: null }
  );
  const diff = useShapeDiff(handle, baseline.heads ?? undefined);

  // Per-tool atom feeding `DiffShapeWrapper` (read via `useValue`). Created once
  // per mount so multiple tldraw tools don't share styling state.
  const [statusAtom] = useState<DiffStatusAtom>(() =>
    atom("diff status", new Map<TLShapeId, DiffStatus>())
  );
  useEffect(() => {
    statusAtom.set(buildStatusMap(diff));
  }, [diff, statusAtom]);

  // Deleted shapes are gone from the live store, so re-insert them as locked
  // ghosts (styled `tl-diff-deleted`). They never reach Automerge — see
  // `useDeletedGhosts`.
  useDeletedGhosts(store, handle, diff);

  const components = useMemo<TLComponents>(
    () => ({ ShapeWrapper: DiffShapeWrapper }),
    []
  );

  return (
    <DiffStatusContext.Provider value={statusAtom}>
      <Tldraw inferDarkMode autoFocus store={store} components={components}>
        <TldrawInner docUrl={docUrl} />
      </Tldraw>
    </DiffStatusContext.Provider>
  );
}

// Recomputes the diff against `heads` on every doc change. `baseline.heads`
// only moves when the draft is forked (copy-on-write), so without listening to
// the handle the diff would freeze after the first computation. The bump is
// deferred to a microtask so we never recompute synchronously from inside the
// sync layer's own `handle.change` callback.
function useShapeDiff(
  handle: DocHandle<TLDrawDoc>,
  heads: UrlHeads | undefined
): ShapeDiff | null {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let scheduled = false;
    const onChange = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        setTick((t) => t + 1);
      });
    };
    handle.on("change", onChange);
    return () => {
      handle.off("change", onChange);
    };
  }, [handle]);

  return useMemo(() => {
    if (!heads) return null;
    const doc = handle.doc();
    if (!doc) return null;
    try {
      return diffStore(doc, decodeHeads(heads));
    } catch (error) {
      console.warn("[tldraw4/diff] failed to compute diff", error);
      return null;
    }
    // `tick` is intentionally a dependency: it forces recompute on doc change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, heads, tick]);
}

function buildStatusMap(diff: ShapeDiff | null): Map<TLShapeId, DiffStatus> {
  const map = new Map<TLShapeId, DiffStatus>();
  if (!diff) return map;
  for (const id of diff.added) map.set(id, "added");
  for (const id of diff.changed) map.set(id, "changed");
  for (const record of diff.deleted) map.set(record.id as TLShapeId, "deleted");
  return map;
}

// Renders deleted shapes by putting their baseline records back into the
// *tldraw* store as locked ghosts. These are applied via `mergeRemoteChanges`
// (source: "remote"), and the only TLStore->Automerge sync path listens for
// source: "user" — so ghosts never sync back to the doc. `diffStore` reads the
// Automerge doc (not the tldraw store), so ghosts also never re-enter the diff.
function useDeletedGhosts(
  store: TLStoreWithStatus,
  handle: DocHandle<TLDrawDoc>,
  diff: ShapeDiff | null
) {
  const ghostIds = useRef<Set<TLShapeId>>(new Set());

  useEffect(() => {
    const inner = store.store;
    if (!inner) return;

    const desired = new Map<TLShapeId, TLRecord>();
    if (diff) {
      for (const record of diff.deleted) {
        desired.set(record.id as TLShapeId, record);
      }
    }

    // A ghost is only safe to remove if it isn't currently a real record in the
    // doc: if a deleted shape was re-added upstream, the sync layer puts the
    // real record back at the same id, and removing it then would drop the real
    // shape from the view.
    const liveStore = (handle.doc()?.store ?? {}) as Record<string, unknown>;
    const toRemove = [...ghostIds.current].filter(
      (id) => !desired.has(id) && !(id in liveStore)
    );
    const toAdd: TLRecord[] = [];
    for (const [id, record] of desired) {
      if (!ghostIds.current.has(id)) {
        // Fade the ghost via tldraw's first-class `opacity` prop. tldraw writes
        // `opacity` as an inline style on the shape element (Shape.tsx), so a CSS
        // class (`.tl-diff-deleted`) can't override it — the fade has to live on
        // the record itself. The red "removed" glow stays in CSS as a `filter`.
        toAdd.push({ ...record, isLocked: true, opacity: 0.1 } as TLRecord);
      }
    }

    if (toRemove.length === 0 && toAdd.length === 0) return;

    inner.mergeRemoteChanges(() => {
      if (toRemove.length) inner.remove(toRemove);
      if (toAdd.length) inner.put(toAdd);
    });

    for (const id of toRemove) ghostIds.current.delete(id);
    for (const record of toAdd) ghostIds.current.add(record.id as TLShapeId);
  }, [store, handle, diff]);
}

function TldrawInner(props: { docUrl: AutomergeUrl }) {
  const key = useMemo(() => `${props.docUrl}-camera`, [props.docUrl]);

  const editor = useEditor();
  const repo = useRepo();

  const onChange = useCallback(() => {
    if (!editor) return;
    const camstate = editor.getCameraState();
    if (camstate == "moving") {
      // todo debounce?
      localStorage.setItem(key, JSON.stringify(editor.getCamera()));
    }
  }, []);

  useEffect(() => {
    if (!editor) return;

    // Handle pasted/dropped files (images, videos) by storing them as
    // UnixFileEntry automerge docs and referencing them via service-worker URLs.
    editor.registerExternalAssetHandler("file", async ({ file, assetId }) => {
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");

      // Create a stable asset ID if one wasn't provided
      const id = assetId ?? (`asset:${crypto.randomUUID()}` as TLAssetId);

      // Read the file bytes
      const bytes = new Uint8Array(await file.arrayBuffer());

      // Determine extension and name
      const ext = extensionForMimeType(file.type);
      const name =
        file.name && file.name !== "image.png"
          ? file.name
          : `Pasted image on ${new Date().toLocaleDateString()}.${ext}`;

      // Create an automerge doc for the file
      const fileHandle = repo.create<UnixFileEntry>();
      fileHandle.change((doc) => {
        doc.content = bytes;
        doc.extension = ext;
        doc.mimeType = file.type;
        doc.name = name;
      });

      // Build the asset using tldraw's helper to get dimensions etc.
      const asset = await getMediaAssetInfoPartial(file, id, isImage, isVideo);

      // Point the asset's src at the service-worker URL for this doc
      asset.props.src = automergeUrlToServiceWorkerUrl(fileHandle.url);

      return asset as TLAsset;
    });

    // Override the tldraw paste handler to avoid "could not migrate content"
    // errors when pasting from newer tldraw versions (e.g. tldraw.com may
    // run a canary build whose schema sequence versions are ahead of ours).
    editor.registerExternalContentHandler(
      "tldraw",
      ({ point, content }: { point?: VecLike; content: TLContent }) => {
        editor.run(() => {
          const selectionBoundsBefore = editor.getSelectionPageBounds();
          editor.markHistoryStoppingPoint("paste");

          for (const shape of content.shapes) {
            if (content.rootShapeIds.includes(shape.id)) {
              shape.isLocked = false;
            }
          }

          // Replace the pasted content's schema with ours so that
          // migrateStoreSnapshot sees matching versions and skips migration
          // rather than failing on unknown future sequence versions.
          content.schema = editor.store.schema.serialize();

          editor.putContentOntoCurrentPage(content, {
            point,
            select: true,
          });

          const selectedBoundsAfter = editor.getSelectionPageBounds();
          if (
            selectionBoundsBefore &&
            selectedBoundsAfter &&
            selectionBoundsBefore.collides(selectedBoundsAfter)
          ) {
            editor.updateInstanceState({ isChangingStyle: true });
          }
        });
      }
    );

    const existing = localStorage.getItem(key);
    if (existing) {
      try {
        const cam = JSON.parse(existing);
        editor.setCamera(cam);
      } catch {
        localStorage.removeItem(key);
      }
    }
    editor.on("change", onChange);
    return () => void editor.off("change", onChange);
  }, [editor]);
  return null;
}

export function render(handle: any, element: any) {
  const root = createRoot(element);
  root.render(
    <RepoContext.Provider value={element.repo}>
      <TldrawTool docUrl={handle.url} element={element} />
    </RepoContext.Provider>
  );
  return () => root.unmount();
}
