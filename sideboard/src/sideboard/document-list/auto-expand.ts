import type { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import type { FolderDoc } from "@inkandswitch/patchwork-filesystem";

/**
 * Walk the folder tree from `folderUrl` and collect the URLs of every folder
 * that has a selected document somewhere in its subtree — i.e. the set of
 * folders that must be expanded for the selection to be visible.
 *
 * This reads folder docs directly (one cached `repo.find` each) rather than
 * relying on mounted components, so it finds the full ancestor chain even for a
 * deeply nested selection whose folders aren't mounted yet. Leaf docs are never
 * loaded — selection is matched against the urls already present in each
 * folder's docrefs.
 *
 * Returns whether `folderUrl`'s subtree contains a selection; ancestors are
 * accumulated into `result`. `visited` is branched per path so a folder that
 * legitimately appears under two parents is handled, while true cycles stop.
 */
export async function collectExpandedFolders(
  repo: Repo,
  folderUrl: AutomergeUrl,
  selected: Set<AutomergeUrl>,
  result: Set<AutomergeUrl>,
  visited: Set<AutomergeUrl>
): Promise<boolean> {
  if (visited.has(folderUrl)) return false;
  const nextVisited = new Set(visited);
  nextVisited.add(folderUrl);

  let doc: FolderDoc | undefined;
  try {
    const handle = await repo.find<FolderDoc>(folderUrl);
    doc = handle.doc();
  } catch {
    return false;
  }
  if (!doc?.docs) return false;

  let contains = false;
  for (const child of doc.docs) {
    if (selected.has(child.url)) {
      contains = true;
    }
    if (child.type === "folder") {
      const childContains = await collectExpandedFolders(
        repo,
        child.url,
        selected,
        result,
        nextVisited
      );
      if (childContains) contains = true;
    }
  }

  if (contains) result.add(folderUrl);
  return contains;
}
