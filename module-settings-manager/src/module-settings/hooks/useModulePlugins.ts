import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  mapArray,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";
import {
  extractUniqueDatatypes,
  matchesDatatype,
  getSupportedDatatypesDisplay,
  type DatatypesDisplay,
} from "../utils/datatypes.ts";
import {
  resolveModuleEntryToFolderUrl,
  type ModuleEntry,
  type ModuleSettingsDocWithBranches,
} from "../utils/module-types.ts";
import { importModuleDescriptorsViaWorker } from "../workers/module-loader-client.ts";
import type {
  Plugin,
  PluginDescription,
} from "@inkandswitch/patchwork-plugins";

interface UseModulePluginsParams {
  modules: ModuleEntry[];
  settingsDoc: ModuleSettingsDocWithBranches;
  /**
   * The current user's own settings doc, when it differs from `settingsDoc`.
   * Its branch overrides win (mirroring the watcher), so the displayed folder
   * URL matches what's actually loaded — otherwise the plugin status would
   * read "shadowed" and the activate button would appear spuriously.
   */
  userSettingsDoc?: ModuleSettingsDocWithBranches;
  repo: Repo;
  searchQuery: Accessor<string>;
  filterPluginType: Accessor<string>;
  filterDataType: Accessor<string>;
  sortOrder: Accessor<
    "name-asc" | "name-desc" | "type-asc" | "type-desc" | "id-asc" | "id-desc"
  >;
}

export interface PackageInfo {
  title?: string;
  name?: string;
  version?: string;
}

export type EnrichedPlugin = Plugin<PluginDescription> & {
  isValidUrl: boolean;
  datatypesDisplay: DatatypesDisplay;
  packageName?: string;
  packageTitle?: string;
};

export interface ModuleLoadState {
  url: ModuleEntry;
  loading: boolean;
  error: unknown;
  folderUrl?: AutomergeUrl;
  pkgInfo?: PackageInfo;
  plugins: EnrichedPlugin[];
}

interface ModulePayload {
  folderUrl?: AutomergeUrl;
  pkgInfo?: PackageInfo;
  plugins: EnrichedPlugin[];
}

export function useModulePlugins(params: UseModulePluginsParams) {
  const {
    modules,
    settingsDoc,
    repo,
    searchQuery,
    filterPluginType,
    filterDataType,
    sortOrder,
  } = params;

  // User-first, like the watcher — mirrors chosenBranchFor in module-watcher.
  const settingsDocs = () => [params.userSettingsDoc, settingsDoc];

  // Per-URL load state. The resource throws on failure so the state carries
  // the error and the UI can render an entry for every module — including
  // ones that fail to resolve, import, or that produce no plugins.
  const moduleStateAccessors = mapArray(
    () => modules,
    (url) => {
      // Bumped whenever the entry doc or its resolved folder doc changes heads.
      // sourceKey below only tracks the entry URL and branch *selection*, so
      // without this a new package version (new heads) — or a branches doc
      // retargeting a branch — would never re-run discovery. See the effect
      // below that subscribes to the underlying handles.
      const [refetchToken, setRefetchToken] = createSignal(0);

      const sourceKey = () => {
        const branchKey = isValidAutomergeUrl(url)
          ? (url as AutomergeUrl)
          : undefined;
        const userBranch = branchKey
          ? (params.userSettingsDoc?.branches?.[branchKey] ?? "")
          : "";
        const viewedBranch = branchKey
          ? (settingsDoc.branches?.[branchKey] ?? "")
          : "";
        return `${url}|${userBranch}|${viewedBranch}|${refetchToken()}`;
      };
      const [resource] = createResource<ModulePayload, string>(
        sourceKey,
        async () => {
          const validAutomergeUrl = isValidAutomergeUrl(url);
          // The bare folder URL drives live subscriptions and plugin-status
          // matching; discovery and metadata are always pinned to heads (below).
          const folderUrl = validAutomergeUrl
            ? await resolveModuleEntryToFolderUrl(
                repo,
                url as AutomergeUrl,
                settingsDocs()
              )
            : undefined;
          if (validAutomergeUrl && !folderUrl) {
            throw new Error("Could not resolve module entry to a folder URL");
          }

          // Pin the folder doc to its current heads so descriptor discovery
          // (and the service-worker / ES-module cache the worker's import hits)
          // key on this exact version. A bare URL would be served from cache and
          // keep returning the first version imported this session.
          let folderUrlAtHeads: AutomergeUrl | undefined;
          if (folderUrl) {
            const folderHandle = await repo.find(folderUrl);
            folderUrlAtHeads = folderHandle.view(folderHandle.heads()).url;
          }

          // For an Automerge package, discover its plugins' descriptions in
          // a worker instead of importing (and running) the package here —
          // see module-loader-client.ts. Non-Automerge URLs have no worker
          // counterpart and are imported directly.
          const plugins = validAutomergeUrl
            ? ((await importModuleDescriptorsViaWorker(folderUrlAtHeads!))
                .plugins as unknown as Plugin<PluginDescription>[])
            : (((await import(/* @vite-ignore */ url))?.plugins ??
                []) as Plugin<PluginDescription>[]);

          let pkgInfo: PackageInfo | undefined;
          if (folderUrlAtHeads) {
            try {
              const pkgJsonUrl = new URL(
                "package.json",
                new URL(
                  automergeUrlToServiceWorkerUrl(folderUrlAtHeads),
                  window.location.origin
                )
              ).href;
              const res = await fetch(pkgJsonUrl);
              if (res.ok) {
                const pkg = await res.json();
                pkgInfo = {
                  title: pkg.title,
                  name: pkg.name,
                  version: pkg.version,
                };
              }
            } catch {
              // package.json is optional metadata
            }
          }

          const enriched = plugins.map(
            (plugin): EnrichedPlugin => ({
              ...plugin,
              importUrl: url,
              packageName: pkgInfo?.name,
              packageTitle: pkgInfo?.title,
              isValidUrl: validAutomergeUrl,
              datatypesDisplay: getSupportedDatatypesDisplay(
                "supportedDatatypes" in plugin
                  ? (plugin.supportedDatatypes as string[] | string | undefined)
                  : undefined
              ),
            })
          );

          return { folderUrl, pkgInfo, plugins: enriched };
        }
      );

      // Re-run discovery when the underlying docs actually change. Watch the
      // entry doc (always) and, for a branches entry, the resolved folder doc
      // — a folder doc's content update never touches the branches doc, so the
      // branches doc's own "change" events can't stand in for it. We subscribe
      // to the *bare* (live) folder URL; a heads-pinned handle is a frozen
      // snapshot and wouldn't emit changes past its heads.
      createEffect(() => {
        if (!isValidAutomergeUrl(url)) return;
        // Depend on the current resolution so we re-subscribe if a branch is
        // retargeted to a different folder doc.
        const folderUrl = resource.latest?.folderUrl;
        let disposed = false;
        const cleanups: Array<() => void> = [];
        const bump = () => {
          if (!disposed) setRefetchToken((n) => n + 1);
        };
        void (async () => {
          const entryHandle = await repo.find(url as AutomergeUrl);
          if (disposed) return;
          entryHandle.on("change", bump);
          cleanups.push(() => entryHandle.off("change", bump));
          if (folderUrl && folderUrl !== url) {
            const folderHandle = await repo.find(folderUrl);
            if (disposed) return;
            folderHandle.on("change", bump);
            cleanups.push(() => folderHandle.off("change", bump));
          }
        })();
        onCleanup(() => {
          disposed = true;
          for (const off of cleanups) off();
        });
      });

      createEffect(() => {
        if (resource.error) {
          console.error(`Failed to load plugins for ${url}`, resource.error);
        }
      });

      return (): ModuleLoadState => {
        const payload = resource.error ? undefined : resource.latest;
        return {
          url,
          loading: resource.loading,
          error: resource.error,
          folderUrl: payload?.folderUrl,
          pkgInfo: payload?.pkgInfo,
          plugins: payload?.plugins ?? [],
        };
      };
    }
  );

  const moduleStateMap = createMemo(() => {
    const map = new Map<string, ModuleLoadState>();
    for (const get of moduleStateAccessors()) {
      const state = get();
      map.set(String(state.url), state);
    }
    return map;
  });

  const allPlugins = createMemo(() => {
    const out: EnrichedPlugin[] = [];
    for (const state of moduleStateMap().values()) {
      out.push(...state.plugins);
    }
    return out;
  });

  const uniquePluginTypes = createMemo(() => {
    const types = new Set(allPlugins().map((p) => p.type));
    return Array.from(types).sort();
  });

  const uniqueDataTypes = createMemo(() =>
    extractUniqueDatatypes(allPlugins())
  );

  const sortedPlugins = createMemo(() => {
    const plugins = allPlugins();
    const order = sortOrder();
    return [...plugins].sort((a, b) => {
      const aName = a.name || "";
      const bName = b.name || "";
      if (order === "type-asc" || order === "type-desc") {
        const typeCompare = (a.type || "").localeCompare(b.type || "");
        if (typeCompare !== 0)
          return order === "type-asc" ? typeCompare : -typeCompare;
        return aName.localeCompare(bName);
      }
      if (order === "id-asc" || order === "id-desc") {
        const aId = a.id || "";
        const bId = b.id || "";
        const idCompare = aId.localeCompare(bId);
        if (idCompare !== 0) return order === "id-asc" ? idCompare : -idCompare;
        return aName.localeCompare(bName);
      }
      const nameCompare = aName.localeCompare(bName);
      return order === "name-asc" ? nameCompare : -nameCompare;
    });
  });

  const filteredPlugins = createMemo(() => {
    const plugins = sortedPlugins();
    const query = searchQuery().toLowerCase();
    const pluginTypeFilter = filterPluginType();
    const dataTypeFilter = filterDataType();

    return plugins.filter((plugin) => {
      if (query) {
        const matchesQuery =
          plugin.name?.toLowerCase().includes(query) ||
          plugin.type?.toLowerCase().includes(query) ||
          plugin.id?.toLowerCase().includes(query) ||
          plugin.packageName?.toLowerCase().includes(query) ||
          plugin.packageTitle?.toLowerCase().includes(query) ||
          String(plugin.importUrl ?? "")
            .toLowerCase()
            .includes(query);
        if (!matchesQuery) return false;
      }

      if (pluginTypeFilter && plugin.type !== pluginTypeFilter) return false;
      if (dataTypeFilter && !matchesDatatype(plugin, dataTypeFilter))
        return false;

      return true;
    });
  });

  const visibleModuleUrls = createMemo(() => {
    const query = searchQuery().toLowerCase();
    const pluginTypeFilter = filterPluginType();
    const dataTypeFilter = filterDataType();
    const hasFilter = Boolean(query || pluginTypeFilter || dataTypeFilter);
    if (!hasFilter) return [...modules];

    const matchedUrls = new Set<string>();
    for (const plugin of filteredPlugins()) {
      if (plugin.importUrl) matchedUrls.add(String(plugin.importUrl));
    }

    const states = moduleStateMap();
    return modules.filter((url) => {
      const key = String(url);
      if (matchedUrls.has(key)) return true;
      if (query) {
        if (key.toLowerCase().includes(query)) return true;
        const pkgInfo = states.get(key)?.pkgInfo;
        if (pkgInfo?.title?.toLowerCase().includes(query)) return true;
        if (pkgInfo?.name?.toLowerCase().includes(query)) return true;
      }
      return false;
    });
  });

  return {
    moduleStateMap,
    filteredPlugins,
    visibleModuleUrls,
    uniquePluginTypes,
    uniqueDataTypes,
  };
}
