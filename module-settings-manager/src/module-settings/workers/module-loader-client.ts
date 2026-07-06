// Main-thread client for the module-loader worker.
//
// The worker itself is no longer bundled here: the host site emits the
// bootloader's `@inkandswitch/patchwork-bootloader/module-loader-worker` to
// `/module-loader-worker.js` (the same way it emits the automerge/service
// workers), so we just talk to that one over the shared `discover` protocol.
//
// `importModuleDescriptorsViaWorker` asks the worker to import a package's
// entry point and report which plugins it exports, then returns the same
// `{ plugins }` shape callers already expect from importing the module
// directly — except each plugin's `load()` re-imports the package (pinned to
// the same heads) on this thread and picks out the one plugin by id, the way
// the real plugin registry does when a plugin is actually activated.

import { importModuleFromFolderDocUrl } from "@inkandswitch/patchwork-filesystem";
import type { AutomergeUrl } from "@automerge/automerge-repo";

type Descriptor = Record<string, unknown> & { id?: string };

type WorkerReply =
  | { type: "descriptors"; id: number; descriptors: Descriptor[] }
  | { type: "error"; id: number; error: string };

let worker: Worker | undefined;
let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve: (d: Descriptor[]) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (worker) return worker;
  // The bootloader's vite plugin emits its module-loader worker to the site
  // root, so we load it from there rather than bundling our own copy. Its
  // `import()` of package entry points is served by the controlling service
  // worker, exactly as it is for the automerge worker.
  worker = new Worker("/module-loader-worker.js", {
    type: "module",
    name: "module-settings-manager-module-loader",
  });
  worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
    const data = event.data;
    if (!data || (data.type !== "descriptors" && data.type !== "error"))
      return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.type === "descriptors") entry.resolve(data.descriptors);
    else entry.reject(new Error(data.error));
  });
  worker.addEventListener("error", (event) => {
    // An uncaught worker error can't be tied to a single request — fail
    // every outstanding one so callers don't hang.
    const error = new Error(
      `module-loader worker error: ${event.message ?? "unknown"}`
    );
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  });
  return worker;
}

function discoverDescriptors(url: AutomergeUrl): Promise<Descriptor[]> {
  const id = nextRequestId++;
  return new Promise<Descriptor[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type: "discover", id, url });
  });
}

/**
 * Re-import the package at `folderUrl` on this thread and return the live
 * plugin with the given id. Local equivalent of the filesystem package's
 * `importPluginFromFolderDocUrl` — not yet in the published
 * @inkandswitch/patchwork-filesystem version this package depends on.
 */
async function loadPluginById(folderUrl: AutomergeUrl, pluginId: string) {
  const mod = await importModuleFromFolderDocUrl(folderUrl);
  const plugins: any[] = Array.isArray(mod?.plugins) ? mod.plugins : [];
  const plugin = plugins.find((p) => p?.id === pluginId);
  if (!plugin) {
    throw new Error(
      `No plugin "${pluginId}" exported by the package at ${folderUrl}`
    );
  }
  if (typeof plugin.load !== "function") {
    throw new Error(`Plugin "${pluginId}" at ${folderUrl} has no load()`);
  }
  return plugin.load();
}

/**
 * Discover the plugins exported by the package at `folderUrl` without
 * importing (and running) the package itself on this thread — the worker
 * does that off-thread and reports back plain descriptors. Each returned
 * plugin's `load()` is rebuilt to re-import the package here, pinned to the
 * same heads, when it's actually activated.
 */
export async function importModuleDescriptorsViaWorker(
  folderUrl: AutomergeUrl
): Promise<{ plugins: Descriptor[] }> {
  const descriptors = await discoverDescriptors(folderUrl);
  const plugins = descriptors.map((descriptor) => {
    const id = descriptor.id;
    if (typeof id !== "string") return descriptor;
    return {
      ...descriptor,
      load: () => loadPluginById(folderUrl, id),
    };
  });
  return { plugins };
}
