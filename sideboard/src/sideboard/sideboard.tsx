import { makeDocumentProjection } from "@automerge/automerge-repo-solid-primitives";
import { Show } from "solid-js";

import type { PatchworkToolProps, SideboardAccountDoc } from "../types.ts";
import { DocumentListPanel } from "./document-list-panel.tsx";
import { AccountBar } from "./account-bar.tsx";

/**
 * The combined sideboard: the document-list panel for the account's root folder,
 * with the account bar pinned below it. Reads the account document.
 */
export function Sideboard(props: PatchworkToolProps<SideboardAccountDoc>) {
  const doc = makeDocumentProjection(props.handle);

  return (
    <div class="sideboard">
      <Show when={doc.rootFolderUrl}>
        <DocumentListPanel
          folderUrl={doc.rootFolderUrl!}
          repo={props.repo}
          element={props.element}
        />
      </Show>
      <AccountBar
        handle={props.handle}
        repo={props.repo}
        element={props.element}
      />
    </div>
  );
}
