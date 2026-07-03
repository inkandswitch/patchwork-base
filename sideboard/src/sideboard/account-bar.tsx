import { makeDocumentProjection } from "@automerge/automerge-repo-solid-primitives";
import { Show } from "solid-js";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";

import type { PatchworkToolProps, SideboardAccountDoc } from "../types.ts";
import { createOpenEvent } from "./events.ts";

/**
 * The account bar: the contact avatar (opens the account picker), Packages
 * (module settings) and Settings (frame configurator). Usable as its own tool
 * or pinned to the bottom of the combined sideboard.
 */
export function AccountBar(props: PatchworkToolProps<SideboardAccountDoc>) {
  const doc = makeDocumentProjection(props.handle);

  const open = (detail: OpenDocumentEventDetail) =>
    props.element.dispatchEvent(createOpenEvent(detail));

  return (
    <footer class="account-bar">
      <Show when={doc.contactUrl}>
        <button
          type="button"
          class="account-bar__button account-bar__avatar"
          title="Account"
          aria-label="Account"
          onClick={() =>
            open({ url: props.handle.url, toolId: "account-picker" })
          }
        >
          <patchwork-view doc-url={doc.contactUrl!} tool-id="contact-avatar" />
        </button>
      </Show>

      <Show when={doc.moduleSettingsUrl}>
        <button
          type="button"
          class="account-bar__button"
          onClick={() => open({ url: doc.moduleSettingsUrl! })}
        >
          Packages
        </button>
      </Show>

      <button
        type="button"
        class="account-bar__button"
        onClick={() =>
          open({ url: props.handle.url, toolId: "frame-configurator" })
        }
      >
        Settings
      </button>
    </footer>
  );
}
