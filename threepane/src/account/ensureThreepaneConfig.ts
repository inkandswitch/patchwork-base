import type { DocHandle, Repo } from "@automerge/automerge-repo";
import { createDocOfDatatype2 } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc, ThreepaneConfigDoc, ToolRef } from "../types";
import { loadDatatypeWhenReady } from "./ensureSubdocs";

// Title + spacer are intrinsic to the frame's top bar, never configured tools.
const INTRINSIC_DOCTITLE_TOOLS = new Set(["document-title", "spacer"]);

/**
 * Lazily create the threepane layout config doc and point `account.tools.threepane`
 * at it, migrating the legacy `account.*` arrays into its lanes.
 *
 * Non-destructive: the old `documentToolbarToolIds` / `contextToolIds` /
 * `accountSidebarToolId` fields are left untouched so older builds keep working
 * and you can switch branches freely during the PR. Run the (separate, opt-in)
 * cleanupLegacyAccountFields script to remove them later.
 *
 * Idempotent: returns early once `account.tools.threepane` is set.
 */
export async function ensureThreepaneConfig(
  accountHandle: DocHandle<AccountDoc>,
  repo: Repo
) {
  if (accountHandle.doc()?.tools?.["threepane"]) return;

  const datatype = await loadDatatypeWhenReady<ThreepaneConfigDoc>(
    "threepane:config"
  );
  if (!datatype) {
    console.warn("frame: threepane:config datatype never registered");
    return;
  }

  // Re-check after the await in case another tab migrated concurrently.
  if (accountHandle.doc()?.tools?.["threepane"]) return;

  const account = accountHandle.doc();
  const accountDocUrl = accountHandle.url;

  // doctitle + contextbar migrate with the account doc as a placeholder docid
  // (the frame still feeds doctitle the selected doc / contextbar the account
  // doc). The sidebar starts empty — the document list is now an opt-in widget.
  const doctitleTools: ToolRef[] = (account?.documentToolbarToolIds ?? [])
    .filter((id) => !INTRINSIC_DOCTITLE_TOOLS.has(id))
    .map((id) => [id, accountDocUrl]);
  const contextTabs: ToolRef[] = (account?.contextToolIds ?? []).map((id) => [
    id,
    accountDocUrl,
  ]);

  const configHandle = await createDocOfDatatype2<ThreepaneConfigDoc>(
    datatype,
    repo
  );
  configHandle.change((doc) => {
    doc.doctitle.tools = doctitleTools;
    doc.contextbar.tabs = contextTabs;
    doc.sidebar.widgets = [];
  });

  accountHandle.change((acc) => {
    if (!acc.tools) acc.tools = {};
    if (!acc.tools["threepane"]) acc.tools["threepane"] = configHandle.url;
  });
}
