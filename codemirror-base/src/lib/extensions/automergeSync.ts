import { createEffect, onCleanup } from "solid-js";

/** CodeMirror */
import { EditorView } from "@codemirror/view";
import { Compartment, Transaction } from "@codemirror/state";

/** Automerge */
import type { Prop as AutomergeProp } from "@automerge/automerge";
import { automergeSyncPlugin } from "@automerge/automerge-codemirror";
import type {
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo";

/**
 * Create a CodeMirror extension for synchronizing with an Automerge document using a CodeMirror
 Compartment.
 * @param handle The Automerge document handle.
 * @param path The path to the specific document property to synchronize.
 * @returns A tuple containing the extension and a function to create an effect for reconfiguring the extension when the handle or path change (or the handle's backing is swapped in place).
 */
export function createSyncExtension<T>(
  handle: () => DocHandle<T>,
  path: () => AutomergeProp[],
  initialDoc: () => string
) {
  const sync = new Compartment();

  const syncExtension = () =>
    handle() && path()
      ? automergeSyncPlugin({
          handle: handle() as any, // typescript is confused by different version of doc handle
          path: path(),
        })
      : [];

  // Reconfiguring the compartment replaces the sync plugin wholesale (the old
  // instance is destroyed without seeing this transaction, so the full-doc
  // reset below is not echoed back into the automerge doc) and the fresh
  // plugin re-seeds its reconciled heads from the current doc.
  //
  // The reset is a synthetic remote transaction, not a user edit: it must not
  // land on the undo stack (undoing it would restore a different timeline's
  // text and write it back into the doc). Marking it also makes the history
  // reset on `scopeReplaced` (see `createHistoryExtension`) order-independent
  // across the two `change` listeners.
  const createReconfigureEffect = (view: EditorView) =>
    createEffect(() => {
      const rebuild = () => {
        view.dispatch({
          effects: sync.reconfigure(syncExtension()),
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: initialDoc(),
          },
          annotations: [
            Transaction.addToHistory.of(false),
            Transaction.remote.of(true),
          ],
        });
      };
      // Runs inside the effect, so the `handle()`/`path()` reads are tracked
      // and a reactive prop change re-runs this whole wiring.
      rebuild();

      // The draft overlay can re-point a live handle at a different clone
      // without the handle identity changing (a `change` event with
      // `scopeReplaced: true`). The sync plugin diffs incrementally from its
      // reconciled heads, which don't exist in the new backing's history — so
      // rebuild the plugin (and the editor content) from the swapped-in doc.
      const h = handle();
      if (!h) return;
      const onChange = (payload: DocHandleChangePayload<T>) => {
        if (payload.scopeReplaced) rebuild();
      };
      h.on("change", onChange);
      onCleanup(() => h.off("change", onChange));
    });

  return [sync.of(syncExtension()), createReconfigureEffect] as const;
}
