import type { DocHandle, Repo, AutomergeUrl } from "@automerge/automerge-repo";
import type { FolderDoc, DocLink } from "@inkandswitch/patchwork-filesystem";
import { deleteAt } from "@automerge/automerge-repo";
import { log } from "./debug.ts";
import { docLinkFromUrl } from "../lib/doc-link.ts";

// Track loaded folders to prevent memory leaks
const folderCache = new Map<AutomergeUrl, DocHandle<FolderDoc>>();

// Maximum folder nesting depth to prevent stack overflow
const MAX_FOLDER_DEPTH = 20;

// Helper to extract plain data from Automerge proxy objects
// structuredClone doesn't work with Automerge proxies - they contain
// internal symbols and proxies that cannot be cloned
function extractPlainDocLink(docLink: DocLink): DocLink {
  // Explicitly copy only the serializable properties
  const plain: DocLink = {
    url: docLink.url,
    name: docLink.name,
    type: docLink.type,
  };
  return plain;
}

export interface DropOperation {
  draggedIds: string[];
  draggedUrls: AutomergeUrl[];
  // Full payload items, used to add links when the dragged docs
  // aren't part of this sideboard's folder tree
  draggedItems?: Array<{ url: AutomergeUrl; name?: string; type?: string }>;
  targetId: string;
  position: "above" | "below" | "inside";
  sourceToolId: string;
  copyMode: boolean;
}

interface ItemLocation {
  url: AutomergeUrl;
  folderUrl: AutomergeUrl;
  folderPath: number[];
  index: number;
  item: DocLink;
}

interface ItemLocations {
  sourceItems: ItemLocation[];
  targetFolder: AutomergeUrl;
  targetFolderPath: number[];
  targetIndex: number;
}

export async function executeDrop(
  operation: DropOperation,
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>,
  // True when the drop lands in the same <patchwork-view> the drag started in.
  // Only then can items be moved; see step 3.
  sameOriginView: boolean
) {
  log("executeDrop called with:", {
    draggedIds: operation.draggedIds,
    targetId: operation.targetId,
    position: operation.position,
    copyMode: operation.copyMode,
    sourceToolId: operation.sourceToolId,
  });

  // 1. Validate we have items to drop
  if (operation.draggedUrls.length === 0) {
    log("No items to drop");
    return;
  }

  log("Starting location finding...");

  // 2. Find source and target locations
  const locations = await findItemLocations(
    rootFolderHandle,
    operation.draggedUrls,
    operation.targetId,
    repo,
    operation.position
  );

  if (!locations) {
    log("Could not find target location. Target:", operation.targetId);
    return;
  }

  // 3. Move only when the drag started inside *this same* <patchwork-view> and
  // the dragged docs are actually in this tree. A drag from another view, or an
  // external / bare-url drop (neither sets the origin view), is added to the
  // target folder as a link instead. Identity is the view element itself — not
  // the tool id, which is null for the fallback-mounted sideboard and was what
  // made the old check send every in-view drag down this add-link path,
  // duplicating instead of moving.
  if (!sameOriginView || locations.sourceItems.length === 0) {
    log(
      "Cross-view/external drop, adding links. sameOriginView:",
      sameOriginView
    );
    await performAdd(repo, rootFolderHandle, locations, operation);
    return;
  }

  log("Locations found:", {
    sourceItemsCount: locations.sourceItems.length,
    targetFolder: locations.targetFolder,
    targetIndex: locations.targetIndex,
  });

  // 4. Validate drop is legal (no circular references, etc)
  log("Validating drop...");
  const validationError = getDropValidationError(locations, operation);
  if (validationError) {
    log("Invalid drop operation:", validationError);
    return;
  }

  log("Validation passed, executing operation...");

  // 5. Execute the move or copy
  if (operation.copyMode) {
    await performCopy(rootFolderHandle, locations, operation, repo);
  } else {
    await performMove(rootFolderHandle, locations, operation);
  }

  log("Operation complete!");
}

// Remove every doc-link matching one of `urls` from the sideboard's folder
// tree, wherever it lives. Used by the context menu to remove a multi-selection
// in one shot. Deletes are batched per folder and applied high-index-first so
// earlier removals don't shift the indices of later ones.
export async function removeItemsByUrl(
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>,
  urls: AutomergeUrl[]
): Promise<void> {
  const targets = new Set(urls);
  if (targets.size === 0) return;

  const removalsByFolder = new Map<DocHandle<FolderDoc>, number[]>();
  const visited = new Set<AutomergeUrl>();

  async function traverse(
    handle: DocHandle<FolderDoc>,
    depth: number
  ): Promise<void> {
    if (depth >= MAX_FOLDER_DEPTH) return;
    const doc = handle.doc();
    if (!doc?.docs) return;
    visited.add(handle.url);

    for (let i = 0; i < doc.docs.length; i++) {
      const child = doc.docs[i];

      if (targets.has(child.url)) {
        const indices = removalsByFolder.get(handle) ?? [];
        indices.push(i);
        removalsByFolder.set(handle, indices);
      }

      if (
        child.type === "folder" &&
        child.url &&
        child.url !== handle.url &&
        !visited.has(child.url)
      ) {
        let nested = folderCache.get(child.url);
        if (!nested) {
          try {
            nested = await repo.find<FolderDoc>(child.url);
            folderCache.set(child.url, nested);
          } catch (error) {
            log("Failed to load folder while removing:", child.url, error);
            continue;
          }
        }
        await traverse(nested, depth + 1);
      }
    }
  }

  await traverse(rootFolderHandle, 0);

  for (const [handle, indices] of removalsByFolder) {
    const sorted = [...indices].sort((a, b) => b - a);
    handle.change((doc) => {
      for (const index of sorted) deleteAt(doc.docs, index);
    });
  }
}

async function findItemLocations(
  rootFolderHandle: DocHandle<FolderDoc>,
  draggedUrls: AutomergeUrl[],
  targetId: string,
  repo: Repo,
  position: "above" | "below" | "inside"
): Promise<ItemLocations | null> {
  const rootFolder = rootFolderHandle.doc();
  if (!rootFolder) return null;

  const sourceItems: ItemLocation[] = [];
  let targetFolder: AutomergeUrl | null = null;
  let targetFolderPath: number[] | null = null;
  let targetIndex = 0;

  // Track visited folders to prevent infinite recursion
  const visitedFolders = new Set<AutomergeUrl>();

  // Helper to traverse folder tree recursively
  async function traverse(
    folderUrl: AutomergeUrl,
    docs: DocLink[] | undefined,
    path: number[],
    depth: number = 0
  ): Promise<void> {
    if (!docs) return;

    // Prevent infinite recursion with depth limit
    if (depth >= MAX_FOLDER_DEPTH) {
      log(`Max folder depth (${MAX_FOLDER_DEPTH}) reached, stopping traversal`);
      return;
    }

    // Mark this folder as visited
    visitedFolders.add(folderUrl);

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];

      // Check if this is a dragged item
      if (draggedUrls.includes(doc.url)) {
        sourceItems.push({
          url: doc.url,
          folderUrl,
          folderPath: [...path],
          index: i,
          item: doc,
        });
      }

      // Check if this is the target
      const itemId = folderUrl + "/" + i;
      if (itemId === targetId) {
        targetFolder = folderUrl;
        targetFolderPath = [...path];
        targetIndex = i;
      }

      // Check if folder URL matches targetId for above/below/inside positions
      if (doc.type === "folder" && doc.url === targetId) {
        if (position === "above" || position === "below") {
          // Dropping above or below the folder - target is the parent folder
          targetFolder = folderUrl;
          targetFolderPath = [...path];
          targetIndex = i;
        } else if (position === "inside") {
          // Dropping inside the folder - target is the folder itself
          targetFolder = doc.url;
          targetFolderPath = [...path, i];
          targetIndex = 0; // Drop at start of folder
        }
      }

      // Recurse into folders to find nested items
      if (doc.type === "folder" && doc.url) {
        // Skip if folder references itself (only skip recursion, not target matching above)
        if (doc.url === folderUrl) {
          log("Skipping self-referencing folder:", doc.url);
          continue;
        }

        // Skip if we've already visited this folder (prevent circular refs)
        if (visitedFolders.has(doc.url)) {
          log("Skipping already visited folder:", doc.url);
          continue;
        }

        const nestedPath = [...path, i];

        // Load the nested folder if not cached
        let nestedHandle = folderCache.get(doc.url);
        if (!nestedHandle) {
          try {
            nestedHandle = await repo.find<FolderDoc>(doc.url);
            folderCache.set(doc.url, nestedHandle);
          } catch (error) {
            log("Failed to load folder:", doc.url, error);
            continue;
          }
        }

        const nestedFolder = nestedHandle?.doc();
        if (nestedFolder?.docs) {
          await traverse(doc.url, nestedFolder.docs, nestedPath, depth + 1);
        }
      }
    }
  }

  // Start traversal from root
  if (rootFolder.docs) {
    await traverse(rootFolderHandle.url, rootFolder.docs, [], 0);
  }

  // If target is the root folder URL (dropping inside root), set target to root
  if (targetId === rootFolderHandle.url && position === "inside") {
    targetFolder = rootFolderHandle.url;
    targetFolderPath = [];
    targetIndex = 0;
  }

  if (!targetFolder || !targetFolderPath) {
    return null;
  }

  return {
    sourceItems,
    targetFolder,
    targetFolderPath,
    targetIndex,
  };
}

function getDropValidationError(
  locations: ItemLocations,
  operation: DropOperation
): string | null {
  // Check if dropping onto itself
  for (const sourceItem of locations.sourceItems) {
    const sourceId = sourceItem.folderUrl + "/" + sourceItem.index;

    // Prevent dropping item onto itself
    if (sourceId === operation.targetId) {
      return `Cannot drop item onto itself (${sourceItem.item.name})`;
    }

    // Prevent dropping item into its current position
    if (
      sourceItem.folderUrl === locations.targetFolder &&
      operation.position === "inside" &&
      !operation.copyMode
    ) {
      return `Item is already in this folder (${sourceItem.item.name})`;
    }

    // Check if trying to drop folder into itself
    if (
      sourceItem.item.type === "folder" &&
      sourceItem.url === locations.targetFolder
    ) {
      return `Cannot drop folder into itself (${sourceItem.item.name})`;
    }

    // Check if dropping folder into its descendants (circular reference prevention)
    if (sourceItem.item.type === "folder") {
      const isDescendant = isDescendantFolder(
        sourceItem.url,
        locations.targetFolder
      );
      if (isDescendant) {
        return `Cannot drop folder into its own descendant (${sourceItem.item.name})`;
      }
    }
  }

  return null;
}

// Helper to check if targetFolder is a descendant of potentialAncestor
function isDescendantFolder(
  potentialAncestor: AutomergeUrl,
  targetFolder: AutomergeUrl
): boolean {
  if (potentialAncestor === targetFolder) {
    return true;
  }

  // Check cached folder for descendants
  const ancestorHandle = folderCache.get(potentialAncestor);
  if (!ancestorHandle) return false;

  const ancestorDoc = ancestorHandle.doc();
  if (!ancestorDoc?.docs) return false;

  // Recursively check all subfolders
  for (const doc of ancestorDoc.docs) {
    if (doc.type === "folder" && doc.url) {
      if (doc.url === targetFolder) {
        return true;
      }
      if (isDescendantFolder(doc.url, targetFolder)) {
        return true;
      }
    }
  }

  return false;
}

async function performMove(
  rootFolderHandle: DocHandle<FolderDoc>,
  locations: ItemLocations,
  operation: DropOperation
) {
  log(
    `Moving ${locations.sourceItems.length} item(s) to position:`,
    operation.position
  );

  // Group sources by folder for efficient removal
  const sourcesByFolder = new Map<AutomergeUrl, ItemLocation[]>();
  for (const source of locations.sourceItems) {
    const sources = sourcesByFolder.get(source.folderUrl) || [];
    sources.push(source);
    sourcesByFolder.set(source.folderUrl, sources);
  }

  // Remove items from source folders (process each folder once)
  const removedItems: DocLink[] = [];
  for (const [folderUrl, sources] of sourcesByFolder) {
    // Sort by index descending to remove from end first (preserves indices)
    const sorted = [...sources].sort((a, b) => b.index - a.index);

    if (folderUrl === rootFolderHandle.url) {
      // Root level - can modify directly
      rootFolderHandle.change((doc) => {
        for (const source of sorted) {
          const item = extractPlainDocLink(doc.docs[source.index]);
          removedItems.unshift(item);
          deleteAt(doc.docs, source.index);
        }
      });
    } else {
      // Nested folder - need to load and modify
      const folderHandle = folderCache.get(folderUrl);
      if (folderHandle) {
        folderHandle.change((doc) => {
          for (const source of sorted) {
            const item = extractPlainDocLink(doc.docs[source.index]);
            removedItems.unshift(item);
            deleteAt(doc.docs, source.index);
          }
        });
      }
    }
  }

  // Calculate target index (adjust if moving within same folder)
  let finalTargetIndex = locations.targetIndex;

  const sourcesInTargetFolder = sourcesByFolder.get(locations.targetFolder);
  if (sourcesInTargetFolder) {
    // Moving within same folder - adjust for removed items
    const removedBefore = sourcesInTargetFolder.filter(
      (s) => s.index < locations.targetIndex
    ).length;
    finalTargetIndex -= removedBefore;
  }

  // Adjust based on position
  if (operation.position === "above") {
    // Insert before target
  } else if (operation.position === "below") {
    // Insert after target
    finalTargetIndex++;
  } else if (operation.position === "inside") {
    // Insert at beginning of folder
    finalTargetIndex = 0;
  }

  // Insert items at target location
  if (locations.targetFolder === rootFolderHandle.url) {
    // Root level
    rootFolderHandle.change((doc) => {
      doc.docs.splice(finalTargetIndex, 0, ...removedItems);
    });
  } else {
    // Nested folder
    const targetHandle = folderCache.get(locations.targetFolder);
    if (targetHandle) {
      targetHandle.change((doc) => {
        doc.docs.splice(finalTargetIndex, 0, ...removedItems);
      });
    }
  }
}

// Add links for docs dragged in from outside this sideboard's folder tree
async function performAdd(
  repo: Repo,
  rootFolderHandle: DocHandle<FolderDoc>,
  locations: ItemLocations,
  operation: DropOperation
) {
  const candidates = (operation.draggedItems ?? []).filter(
    (item) => item.url && item.url !== locations.targetFolder
  );

  // Don't add items that are already present in the target folder -
  // dropping a doc into a folder it's already in shouldn't duplicate it.
  const targetDocs =
    locations.targetFolder === rootFolderHandle.url
      ? rootFolderHandle.doc()?.docs
      : folderCache.get(locations.targetFolder)?.doc()?.docs;
  const existingUrls = new Set(targetDocs?.map((doc) => doc.url) ?? []);

  const links = (
    await Promise.all(
      candidates
        .filter((item) => !existingUrls.has(item.url))
        .map(async (item): Promise<DocLink | null> => {
          if (item.name && item.type) {
            return { url: item.url, name: item.name, type: item.type };
          }
          // Bare url (e.g. dragged link text) - resolve name/type from the doc
          try {
            return await docLinkFromUrl(repo, item.url);
          } catch (error) {
            log("Failed to resolve dropped doc:", item.url, error);
            return null;
          }
        })
    )
  ).filter((link): link is DocLink => link !== null);

  if (links.length === 0) {
    log("No addable items in external drop (already present or unresolvable)");
    return;
  }

  let finalTargetIndex = locations.targetIndex;
  if (operation.position === "below") {
    finalTargetIndex++;
  } else if (operation.position === "inside") {
    finalTargetIndex = 0;
  }

  log(`Adding ${links.length} link(s) at index:`, finalTargetIndex);

  if (locations.targetFolder === rootFolderHandle.url) {
    rootFolderHandle.change((doc) => {
      doc.docs.splice(finalTargetIndex, 0, ...links);
    });
  } else {
    const targetHandle = folderCache.get(locations.targetFolder);
    if (targetHandle) {
      targetHandle.change((doc) => {
        doc.docs.splice(finalTargetIndex, 0, ...links);
      });
    }
  }
}

async function performCopy(
  rootFolderHandle: DocHandle<FolderDoc>,
  locations: ItemLocations,
  operation: DropOperation,
  _repo: Repo
) {
  log(
    `Copying ${locations.sourceItems.length} item(s) to position:`,
    operation.position
  );

  // Collect items to copy from their source folders
  const itemsToCopy: DocLink[] = [];

  for (const source of locations.sourceItems) {
    let item: DocLink | undefined;

    if (source.folderUrl === rootFolderHandle.url) {
      // Root level
      const doc = rootFolderHandle.doc();
      if (doc?.docs) {
        item = doc.docs[source.index];
      }
    } else {
      // Nested folder
      const folderHandle = folderCache.get(source.folderUrl);
      const doc = folderHandle?.doc();
      if (doc?.docs) {
        item = doc.docs[source.index];
      }
    }

    if (item) {
      const clonedItem = extractPlainDocLink(item);
      clonedItem.name = item.name;
      itemsToCopy.push(clonedItem);
    }
  }

  // Calculate target index
  let finalTargetIndex = locations.targetIndex;

  if (operation.position === "above") {
    // Insert before target
  } else if (operation.position === "below") {
    // Insert after target
    finalTargetIndex++;
  } else if (operation.position === "inside") {
    // Insert at beginning of folder
    finalTargetIndex = 0;
  }

  // Insert copied items at target location
  if (locations.targetFolder === rootFolderHandle.url) {
    // Root level
    rootFolderHandle.change((doc) => {
      doc.docs.splice(finalTargetIndex, 0, ...itemsToCopy);
    });
  } else {
    // Nested folder
    const targetHandle = folderCache.get(locations.targetFolder);
    if (targetHandle) {
      targetHandle.change((doc) => {
        doc.docs.splice(finalTargetIndex, 0, ...itemsToCopy);
      });
    }
  }
}
