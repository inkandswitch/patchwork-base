import type { DocHandle, Repo } from "@automerge/automerge-repo";
import { createDocOfDatatype2 } from "@inkandswitch/patchwork-plugins";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";
import type { AccountDoc } from "../types";
import { loadDatatypeWhenReady } from "./ensureSubdocs";

/**
 * Seed a fresh account with example documents by running each static module
 * bundle's generated `init.js` (emitted by that repo's scripts/bundle.mjs next
 * to its modules.json). Every init script receives the same Examples folder
 * handle, so multiple bundles merge their examples into one folder.
 *
 * Runs at most once per account: the account doc's `exampleDocsSeededAt`
 * marker is claimed *before* seeding (a race between two tabs can at worst
 * skip the examples, never duplicate them), and a deleted Examples folder is
 * never recreated. Accounts that already have documents get the marker but no
 * examples — only truly fresh accounts are seeded.
 */
export async function seedExampleDocuments(
  accountHandle: DocHandle<AccountDoc>,
  repo: Repo
) {
  const account = accountHandle.doc();
  if (!account?.rootFolderUrl || account.exampleDocsSeededAt) return;

  accountHandle.change((doc) => {
    if (!doc.exampleDocsSeededAt) doc.exampleDocsSeededAt = Date.now();
  });

  const rootFolder = await repo.find<FolderDoc>(account.rootFolderUrl);
  if (rootFolder.doc()?.docs?.length) return;

  const initUrls = await bundleInitScriptUrls();
  if (!initUrls.length) return;

  const folderDatatype = await loadDatatypeWhenReady<FolderDoc>("folder");
  if (!folderDatatype) return;
  const folder = await createDocOfDatatype2<FolderDoc>(
    folderDatatype,
    repo,
    (doc) => {
      doc.title = "Examples";
    }
  );

  for (const url of initUrls) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      await mod.default?.(repo, folder);
    } catch {
      // Bundle ships no init script (404) or it failed — nothing to seed.
    }
  }

  // Don't leave an empty Examples folder if no bundle contributed anything.
  if (!folder.doc()?.docs?.length) return;

  rootFolder.change((doc) => {
    doc.docs.unshift({ name: "Examples", type: "folder", url: folder.url });
  });
}

type ModuleWatcherLike = {
  urls?: Record<string, string>;
  doneLoading?: Promise<void>;
};

/**
 * The `init.js` URL next to every static (http) module manifest the host is
 * watching. Automerge module-settings docs have no init script. Waits for the
 * watcher's initial load so the bundles' plugins are registered before any
 * example module asks the registry for a datatype.
 */
async function bundleInitScriptUrls(): Promise<string[]> {
  const watcher = (
    window as { patchwork?: { packages?: ModuleWatcherLike } }
  ).patchwork?.packages;
  if (!watcher?.urls) return [];
  await watcher.doneLoading;
  return Object.values(watcher.urls)
    .filter((url) => typeof url === "string" && !url.startsWith("automerge:"))
    .map((url) => new URL("init.js", new URL(url, document.baseURI)).href);
}
