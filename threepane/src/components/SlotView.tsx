import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { ToolSlot } from "../types";

/**
 * Render one configured tool-lane slot (doctitle / tray).
 *
 * A bare string is a `patchwork:component` id, loaded and rendered with no
 * document. A `[toolId, docId]` tuple renders that tool against the lane's fed
 * document (`docUrl`) — the tuple's own docid is a placeholder here, since the
 * frame feeds doctitle the selected doc and the tray the account doc.
 */
export function SlotView(props: { slot: ToolSlot; docUrl?: AutomergeUrl }) {
  return typeof props.slot === "string" ? (
    <patchwork-view component={props.slot} />
  ) : (
    <patchwork-view doc-url={props.docUrl} tool-id={props.slot[0]} />
  );
}
