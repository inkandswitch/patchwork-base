import { createSignal, onCleanup, Show } from "solid-js";
import {
  makeDocumentProjection,
  useDocHandle,
  useDocument,
} from "solid-automerge";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo";
import type { ModuleSettingsDoc } from "@inkandswitch/patchwork-filesystem";
import type { PatchworkToolProps } from "../types.ts";
import { ModuleFilters, PackageList } from "./components";
import { useModulePlugins } from "./hooks/useModulePlugins.ts";
import { MODULE_FETCH_DEBOUNCE } from "./constants.ts";
import { DebugToggle } from "./components/DebugToggle.tsx";
import { unregisterPlugins } from "@inkandswitch/patchwork-plugins";
import type { ModuleSettingsDocWithBranches } from "./utils/module-types.ts";

type AccountDocLike = { moduleSettingsUrl?: AutomergeUrl };

export function ModuleSettings(props: PatchworkToolProps<ModuleSettingsDoc>) {
  const [searchInputValue, setSearchInputValue] = createSignal("");
  const [debouncedSearch, setDebouncedSearch] = createSignal("");
  const [sortOrder] = createSignal<
    "name-asc" | "name-desc" | "type-asc" | "type-desc" | "id-asc" | "id-desc"
  >("name-asc");
  const [filterPluginType, setFilterPluginType] = createSignal<string>("");
  const [filterDataType, setFilterDataType] = createSignal<string>("");
  const settingsHandle =
    props.handle as DocHandle<ModuleSettingsDocWithBranches>;
  const doc = makeDocumentProjection(settingsHandle);

  const accountUrl = localStorage.getItem("tinyPatchworkAccountUrl");
  const [accountDoc] = useDocument<AccountDocLike>(
    isValidAutomergeUrl(accountUrl ?? "")
      ? (accountUrl as AutomergeUrl)
      : undefined,
    { repo: props.repo }
  );
  const ownModuleSettingsUrl = () => accountDoc()?.moduleSettingsUrl;
  const isForeignSettingsDoc = () => {
    const ownUrl = ownModuleSettingsUrl();
    return !!ownUrl && ownUrl !== props.handle.url;
  };
  const ownSettingsHandle = useDocHandle<ModuleSettingsDocWithBranches>(
    () => (isForeignSettingsDoc() ? ownModuleSettingsUrl() : undefined),
    { repo: props.repo }
  );

  // Debounce search to avoid expensive filtering on every keystroke
  let searchTimeout: ReturnType<typeof setTimeout> | null = null;

  const handleSearchChange = (value: string) => {
    setSearchInputValue(value);

    if (searchTimeout) clearTimeout(searchTimeout);

    searchTimeout = setTimeout(() => {
      setDebouncedSearch(value);
    }, MODULE_FETCH_DEBOUNCE);
  };

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  // Load and filter plugins
  const {
    moduleStateMap,
    filteredPlugins,
    visibleModuleUrls,
    uniquePluginTypes,
    uniqueDataTypes,
  } = useModulePlugins({
      modules: doc.modules,
      settingsDoc: doc,
      repo: props.repo,
      searchQuery: debouncedSearch,
      filterPluginType,
      filterDataType,
      sortOrder,
    });

  const handleAddModule = (url: AutomergeUrl) => {
    props.handle.change((doc) => {
      if (!doc.modules.includes(url)) {
        doc.modules.push(url);
      }
    });
  };

  const handleRemoveModule = (url: AutomergeUrl) => {
    unregisterPlugins(url);
    props.handle.change((doc) => {
      const idx = doc.modules.indexOf(url);
      if (idx !== -1) {
        doc.modules.splice(idx, 1);
      }
    });
  };

  const isModuleInstalled = (url: AutomergeUrl) => {
    return doc.modules.includes(url);
  };

  return (
    <div
      class="module-settings-manager"
      classList={{
        "module-settings-manager--foreign": isForeignSettingsDoc(),
      }}
    >
      <Show when={isForeignSettingsDoc()}>
        <div class="module-settings-manager__foreign-warning">
          Viewing a module settings doc that is not your own
        </div>
      </Show>
      <div class="module-settings-manager__content-container">
        <h2 class="module-settings-manager__title">Packages</h2>

        <div class="module-settings-manager__content">
          <ModuleFilters
            searchQuery={searchInputValue()}
            onSearchChange={handleSearchChange}
            filterPluginType={filterPluginType()}
            onPluginTypeChange={setFilterPluginType}
            filterDataType={filterDataType()}
            onDataTypeChange={setFilterDataType}
            uniquePluginTypes={uniquePluginTypes()}
            uniqueDataTypes={uniqueDataTypes()}
            repo={props.repo}
            onAdd={handleAddModule}
            isInstalled={isModuleInstalled}
          />
          <PackageList
            moduleUrls={visibleModuleUrls()}
            moduleStateMap={moduleStateMap()}
            filteredPlugins={filteredPlugins()}
            onRemoveModule={handleRemoveModule}
            repo={props.repo}
            settingsHandle={settingsHandle}
            userSettingsHandle={ownSettingsHandle()}
          />
        </div>
      </div>

      <footer class="module-settings-manager__footer">
        <DebugToggle />
      </footer>
    </div>
  );
}
