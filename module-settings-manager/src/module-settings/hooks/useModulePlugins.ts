import { createMemo, createResource, mapArray, type Accessor } from "solid-js";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo";
import {
  importModuleFromFolderDocUrl,
  automergeUrlToServiceWorkerUrl,
} from "@inkandswitch/patchwork-filesystem";
import {
  extractUniqueDatatypes,
  matchesDatatype,
  getSupportedDatatypesDisplay,
  type DatatypesDisplay,
} from "../utils/datatypes.ts";
import {
  resolveModuleEntryToFolderUrl,
  type ModuleSettingsDocWithBranches,
} from "../utils/module-types.ts";
import type {
  Plugin,
  PluginDescription,
} from "@inkandswitch/patchwork-plugins";

interface UseModulePluginsParams {
  modules: AutomergeUrl[];
  settingsDoc: ModuleSettingsDocWithBranches;
  repo: Repo;
  searchQuery: Accessor<string>;
  filterPluginType: Accessor<string>;
  filterDataType: Accessor<string>;
  sortOrder: Accessor<
    "name-asc" | "name-desc" | "type-asc" | "type-desc" | "id-asc" | "id-desc"
  >;
}

export type EnrichedPlugin = Plugin<PluginDescription> & {
  isValidUrl: boolean;
  datatypesDisplay: DatatypesDisplay;
  packageName?: string;
  packageTitle?: string;
};

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

  // Load all plugins from user's modules. A module URL may point to a
  // branches doc; resolve it to the chosen branch's folder/directory URL
  // before importing. We attach the original module URL as importUrl so
  // the table reflects what's actually listed in the settings doc.
  const modulePlugins = mapArray(
    () => modules,
    (url) => {
      // String key keeps createResource stable; only re-fetches when the URL
      // or the chosen branch (when applicable) actually changes.
      const sourceKey = () => `${url}|${settingsDoc.branches?.[url] ?? ""}`;
      const [plugins] = createResource(sourceKey, async () => {
        try {
          const folderUrl = await resolveModuleEntryToFolderUrl(
            repo,
            url,
            settingsDoc
          );
          if (!folderUrl) return [];
          const module = await importModuleFromFolderDocUrl(folderUrl);
          const plugins = (module?.plugins || []) as Plugin<PluginDescription>[];

          let packageName: string | undefined;
          let packageTitle: string | undefined;
          try {
            const pkgJsonUrl = new URL(
              "package.json",
              new URL(
                automergeUrlToServiceWorkerUrl(folderUrl),
                window.location.origin
              )
            ).href;
            const res = await fetch(pkgJsonUrl);
            if (res.ok) {
              const pkg = await res.json();
              packageName = pkg.name;
              packageTitle = pkg.title;
            }
          } catch {
            // ignore — package.json is optional metadata for filtering
          }

          return plugins.map((plugin) => ({
            ...plugin,
            importUrl: url,
            packageName,
            packageTitle,
          }));
        } catch (error) {
          console.error(`Failed to load plugins for ${url}`, error);
          return [];
        }
      });
      return plugins;
    }
  );

  // Flatten all plugin accessors into a single array
  const allPlugins = createMemo(() => {
    return modulePlugins().flatMap(
      (pluginsAccessor) => pluginsAccessor() || []
    );
  });

  // Get unique plugin types for filter dropdown
  const uniquePluginTypes = createMemo(() => {
    const plugins = allPlugins();
    if (!plugins) return [];
    const types = new Set(plugins.map((p) => p.type));
    return Array.from(types).sort();
  });

  // Get unique data types for filter dropdown
  const uniqueDataTypes = createMemo(() => {
    const plugins = allPlugins();
    if (!plugins) return [];
    return extractUniqueDatatypes(plugins);
  });

  // Sort plugins first (only re-runs when allPlugins or sortOrder changes)
  const sortedPlugins = createMemo(() => {
    const plugins = allPlugins();
    if (!plugins) return [];

    const order = sortOrder();
    return [...plugins].sort((a, b) => {
      if (order === "type-asc" || order === "type-desc") {
        const typeCompare = a.type.localeCompare(b.type);
        if (typeCompare !== 0)
          return order === "type-asc" ? typeCompare : -typeCompare;
        return a.name.localeCompare(b.name);
      }
      if (order === "id-asc" || order === "id-desc") {
        const aId = a.id || "";
        const bId = b.id || "";
        const idCompare = aId.localeCompare(bId);
        if (idCompare !== 0) return order === "id-asc" ? idCompare : -idCompare;
        return a.name.localeCompare(b.name);
      }
      const nameCompare = a.name.localeCompare(b.name);
      return order === "name-asc" ? nameCompare : -nameCompare;
    });
  });

  // Filter sorted plugins (re-runs when search/filters change, but not on sort)
  const filteredPlugins = createMemo(() => {
    const plugins = sortedPlugins();

    const query = searchQuery().toLowerCase();
    const pluginTypeFilter = filterPluginType();
    const dataTypeFilter = filterDataType();

    // Filter plugins by search query, plugin type, and data type
    return plugins.filter((plugin) => {
      // Apply search query filter
      if (query) {
        const ext = plugin as Plugin<PluginDescription> & {
          packageName?: string;
          packageTitle?: string;
        };
        const matchesQuery =
          plugin.name.toLowerCase().includes(query) ||
          plugin.type.toLowerCase().includes(query) ||
          plugin.id?.toLowerCase().includes(query) ||
          ext.packageName?.toLowerCase().includes(query) ||
          ext.packageTitle?.toLowerCase().includes(query);
        if (!matchesQuery) return false;
      }

      // Apply plugin type filter
      if (pluginTypeFilter && plugin.type !== pluginTypeFilter) {
        return false;
      }

      // Apply data type filter
      if (dataTypeFilter && !matchesDatatype(plugin, dataTypeFilter)) {
        return false;
      }

      return true;
    });
  });

  // Pre-compute plugin metadata to avoid expensive render-time computations
  const enrichedPlugins = createMemo((): EnrichedPlugin[] => {
    return filteredPlugins().map((plugin) => ({
      ...plugin,
      isValidUrl: isValidAutomergeUrl(plugin.importUrl),
      datatypesDisplay: getSupportedDatatypesDisplay(
        "supportedDatatypes" in plugin
          ? (plugin.supportedDatatypes as string[] | string | undefined)
          : undefined
      ),
    }));
  });

  return {
    allPlugins,
    filteredPlugins: enrichedPlugins,
    uniquePluginTypes,
    uniqueDataTypes,
  };
}
