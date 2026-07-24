import { createEffect, onCleanup } from "solid-js";

/** CodeMirror */
import { EditorView, keymap } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { history, historyKeymap } from "@codemirror/commands";

/** Automerge */
import type {
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo";

/**
 * Undo/redo history, owned by the base editor. Tools must not add their own
 * `history()`: the underlying history state field is a module-level singleton
 * in `@codemirror/commands`, so a second copy elsewhere in the configuration
 * would keep the field alive across our reset and defeat it.
 *
 * The stack is reset whenever the handle's backing is swapped in place (a
 * `change` event with `scopeReplaced: true` — e.g. scrubbing history or
 * switching drafts re-points the handle at a different clone): the old
 * entries describe a different timeline, and undo must only revert what the
 * user has done since. CodeMirror has no clear-history API; the sanctioned
 * reset is cycling the extension out of and back into the configuration,
 * which drops the history field's state and re-creates it empty.
 */
export function createHistoryExtension<T>(handle: () => DocHandle<T>) {
  const compartment = new Compartment();
  const historyExtension = () => [history(), keymap.of(historyKeymap)];

  const createResetEffect = (view: EditorView) =>
    createEffect(() => {
      const h = handle();
      if (!h) return;
      const onChange = (payload: DocHandleChangePayload<T>) => {
        if (!payload.scopeReplaced) return;
        // Two dispatches: the first removes the history field (dropping its
        // state), the second re-adds it empty. The sync extension's rebuild
        // for the same event is dispatched with `addToHistory: false`, so the
        // relative order of the two `change` listeners doesn't matter.
        view.dispatch({ effects: compartment.reconfigure([]) });
        view.dispatch({
          effects: compartment.reconfigure(historyExtension()),
        });
      };
      h.on("change", onChange);
      onCleanup(() => h.off("change", onChange));
    });

  return [compartment.of(historyExtension()), createResetEffect] as const;
}
