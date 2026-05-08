import type { AutomergeUrl } from "@automerge/automerge-repo";
import type { Accessor } from "solid-js";
import { Show } from "solid-js";

interface DocumentToolbarProps {
  toolIds: Accessor<string[] | undefined>;
  docUrl: Accessor<AutomergeUrl | undefined>;
}

export function DocumentToolbar(props: DocumentToolbarProps) {
  return (
    <Show when={props.docUrl() && props.toolIds()} keyed>
      {(ids) => (
        <div class="toolbar">
          {ids.map((toolId) => (
            <patchwork-view
              doc-url={props.docUrl()!}
              tool-id={toolId}
            />
          ))}
        </div>
      )}
    </Show>
  );
}
