import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { createDocOfDatatype2 } from "@inkandswitch/patchwork-plugins";
import type { AccountDoc, ThreepaneConfigDoc, ToolRef, ToolSlot } from "../types";
import { loadDatatypeWhenReady } from "./ensureSubdocs";

// Title + spacer are intrinsic to the frame's top bar, never configured tools.
const INTRINSIC_DOCTITLE_TOOLS = new Set(["document-title", "spacer"]);

// The sidebar's default widget: a document list pinned to the account's root
// folder. Every account gets one so the left pane is never empty.
const DOCUMENT_LIST_TOOL = "chee/document-list";

/** The default sidebar widgets for a fresh (or empty) account. */
function defaultSidebarWidgets(rootFolderUrl?: AutomergeUrl): ToolRef[] {
  return rootFolderUrl ? [[DOCUMENT_LIST_TOOL, rootFolderUrl]] : [];
}

/**
 * Lazily create the threepane layout config doc and point `account.tools.threepane`
 * at it, migrating the legacy `account.*` arrays into its lanes.
 *
 * Seeds the sidebar with a default document-list widget (pinned to the account's
 * root folder), so the left pane is never empty. Expects `rootFolderUrl` to be
 * populated already — call after `ensureAccountSubdocs`.
 *
 * Non-destructive: the old `documentToolbarToolIds` / `contextToolIds` /
 * `accountSidebarToolId` fields are left untouched so older builds keep working
 * and you can switch branches freely during the PR. Run the (separate, opt-in)
 * cleanupLegacyAccountFields script to remove them later.
 */
export async function ensureThreepaneConfig(
  accountHandle: DocHandle<AccountDoc>,
  repo: Repo
) {
  const rootFolderUrl = accountHandle.doc()?.rootFolderUrl;
  const existingConfigUrl = accountHandle.doc()?.tools?.["threepane"];

  // Already migrated. Backfill lanes added by later builds of this branch:
  // the `tray` lane (absent in the first cut) and the default document-list
  // widget (some early builds seeded an empty sidebar).
  if (existingConfigUrl) {
    const configHandle = await repo.find<ThreepaneConfigDoc>(existingConfigUrl);
    configHandle.change((doc) => {
      if (!doc.tray) doc.tray = { tools: [] };
      if (rootFolderUrl && !doc.sidebar?.widgets?.length) {
        doc.sidebar.widgets = defaultSidebarWidgets(rootFolderUrl);
      }
    });
    return;
  }

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

  // contextbar migrates with the account doc as a placeholder docid (the frame
  // still feeds it the account doc). doctitle tools migrate as bare ids: the
  // frame always points them at the selected main-view doc, so a slot tuple's
  // docid would be ignored — keep them as plain strings. The sidebar is seeded
  // with the default document-list widget.
  const doctitleTools: ToolSlot[] = (account?.documentToolbarToolIds ?? [])
    .filter((id) => !INTRINSIC_DOCTITLE_TOOLS.has(id));
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
    doc.sidebar.widgets = defaultSidebarWidgets(account?.rootFolderUrl);
  });

  accountHandle.change((acc) => {
    if (!acc.tools) acc.tools = {};
    if (!acc.tools["threepane"]) acc.tools["threepane"] = configHandle.url;
  });
}
