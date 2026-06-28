import type { AutomergeUrl, DocHandle, Repo } from "@automerge/automerge-repo";
import { getType } from "@inkandswitch/patchwork-filesystem";
import type { ModuleSettingsDoc } from "@inkandswitch/patchwork-filesystem";

export type ModuleEntry = string;

/** The encoded heads of a document — the return type of `handle.heads()`. */
export type UrlHeads = ReturnType<DocHandle<unknown>["heads"]>;

export type BranchesDoc = {
  "@patchwork": { type: "branches" };
  branches: { [branchName: string]: AutomergeUrl };
};

// Until @inkandswitch/patchwork-filesystem ships .branches in ModuleSettingsDoc.
export type ModuleSettingsDocWithBranches = Omit<
  ModuleSettingsDoc,
  "modules"
> & {
  modules: ModuleEntry[];
  branches?: Record<AutomergeUrl, string>;
  /**
   * Pins a folder module to a frozen previous version, keyed by the folder doc
   * URL. The watcher loads the exact (already-cached) versioned URL and does not
   * hot-reload it. Mirrors `branches` as a user-local override map.
   */
  pinned?: Record<AutomergeUrl, UrlHeads>;
};

export type ModuleEntryKind = "folder" | "directory" | "branches" | "unknown";

export const DEFAULT_BRANCH = "default";

export function getModuleEntryKind(doc: unknown): ModuleEntryKind {
  if (!doc || typeof doc !== "object") return "unknown";
  const type = getType(doc as Parameters<typeof getType>[0]);
  if (type === "directory") return "directory";
  if (type === "branches") return "branches";
  if ("docs" in doc && Array.isArray((doc as { docs?: unknown }).docs)) {
    return "folder";
  }
  return "unknown";
}

/**
 * Look up the chosen branch name for a branches doc by checking each settings
 * doc in priority order. Pass `[userDoc, viewedDoc]` to mirror the watcher,
 * which lets a user-local override beat the viewed doc's choice.
 */
export function chosenBranchFor(
  settingsDocs: (ModuleSettingsDocWithBranches | undefined)[],
  branchesDocUrl: AutomergeUrl
): string {
  for (const doc of settingsDocs) {
    const branch = doc?.branches?.[branchesDocUrl];
    if (branch) return branch;
  }
  return DEFAULT_BRANCH;
}

/**
 * Read the active pin for a folder doc, mirroring {@link chosenBranchFor}: the
 * user's settings doc (passed first) wins over a viewed foreign doc.
 */
export function chosenPinFor(
  settingsDocs: (ModuleSettingsDocWithBranches | undefined)[],
  folderUrl: AutomergeUrl
): UrlHeads | undefined {
  for (const doc of settingsDocs) {
    const heads = doc?.pinned?.[folderUrl];
    if (heads) return heads;
  }
  return undefined;
}

export type PublishVersion = { heads: UrlHeads; at: number };

/**
 * List the distinct *published* versions of a folder doc, newest first. Folder
 * docs bump `lastSyncAt` once per publish, so we walk the change history and
 * collapse runs that share a `lastSyncAt` into a single entry. Capped to the
 * most recent `limit` publishes to bound the cost of viewing each point.
 */
export function publishVersions(
  handle: DocHandle<{ lastSyncAt?: number }>,
  limit = 50
): PublishVersion[] {
  const history = handle.history() ?? [];
  const out: PublishVersion[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < limit; i--) {
    const heads = history[i];
    const at = handle.view(heads).doc()?.lastSyncAt ?? 0;
    if (out.length && out[out.length - 1].at === at) continue;
    out.push({ heads, at });
  }
  return out;
}

export async function resolveModuleEntryToFolderUrl(
  repo: Repo,
  url: AutomergeUrl,
  settingsDocs: (ModuleSettingsDocWithBranches | undefined)[]
): Promise<AutomergeUrl | undefined> {
  const handle = await repo.find(url);
  const doc = handle.doc();
  const kind = getModuleEntryKind(doc);
  if (kind !== "branches") return url;
  const branchName = chosenBranchFor(settingsDocs, url);
  const branchUrl = (doc as BranchesDoc | undefined)?.branches?.[branchName];
  return branchUrl;
}
