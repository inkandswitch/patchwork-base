// Dedicated worker for plugin-descriptor discovery, mirroring the pattern in
// ../app's core/bootloader/src/module-loader-worker.ts.
//
// A module-settings doc lists Automerge folder-doc packages. To list the
// plugins a package provides we only need their *descriptions* (id, type,
// name, icon…), not their implementations. This worker imports a package's
// entry point off the main thread purely to read its exported `plugins`
// array, strips the non-cloneable `load()`, and posts the plain descriptors
// back. The main thread re-imports the package (pinned to the same heads)
// only when a plugin is actually activated — see module-loader-client.ts.

import { importModuleFromFolderDocUrl } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeUrl } from "@automerge/automerge-repo";

// @inkandswitch/patchwork-filesystem reads `window.location` directly, which
// doesn't exist in a dedicated worker's global scope.
(globalThis as { window?: unknown }).window ??= globalThis;

type DiscoverRequest = {
  type: "discover";
  id: number;
  url: AutomergeUrl;
};

function isDiscoverRequest(data: unknown): data is DiscoverRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as any).type === "discover" &&
    typeof (data as any).id === "number" &&
    typeof (data as any).url === "string"
  );
}

// Keep only the structured-cloneable description fields. `load` is a closure
// and can't cross the worker boundary — the main thread rebuilds it by
// re-importing the package and calling the live plugin's own `load()`.
function toDescriptor(plugin: any): Record<string, unknown> {
  if (!plugin || typeof plugin !== "object") return {};
  const { load, ...description } = plugin;
  return description;
}

self.addEventListener("message", (event: MessageEvent) => {
  const data = event.data;
  if (!isDiscoverRequest(data)) return;
  const { id, url } = data;

  importModuleFromFolderDocUrl(url)
    .then((mod) => {
      const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
      const descriptors = plugins.map(toDescriptor);
      (self as unknown as Worker).postMessage({
        type: "descriptors",
        id,
        descriptors,
      });
    })
    .catch((error) => {
      (self as unknown as Worker).postMessage({
        type: "error",
        id,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    });
});
