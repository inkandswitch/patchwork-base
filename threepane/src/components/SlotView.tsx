import { Show } from "solid-js";
import type { ToolSlot } from "../types";

/** The id that identifies a slot regardless of its kind (tool tuple or component string). */
export const slotId = (slot: ToolSlot): string =>
  typeof slot === "string" ? slot : slot[0];

/**
 * Render one configured tool-lane slot (doctitle / sidebar / tray / contextbar).
 *
 * A bare string is a `patchwork:component` id, loaded and rendered with no
 * document. A `[toolId, docId]` tuple renders that tool against the doc the
 * tuple itself names — each slot carries its own document.
 *
 * The tuple-vs-string check is a reactive `<Show>` rather than a plain ternary:
 * a slot can flip kind in place (e.g. a migrated `[toolId, docid]` tuple
 * rewritten to a bare component string) while this component stays mounted, and
 * a ternary — evaluated once when the component runs — would freeze on the stale
 * branch and index the string as if it were a tuple.
 */
export function SlotView(props: { slot: ToolSlot }) {
  return (
    <Show
      when={typeof props.slot !== "string" ? props.slot : false}
      fallback={<patchwork-view component={props.slot as string} />}
    >
      {(tuple) => (
        <patchwork-view doc-url={tuple()[1]} tool-id={tuple()[0]} />
      )}
    </Show>
  );
}
