import {
  For,
  Show,
  createSignal,
  onMount,
  onCleanup,
  createEffect,
} from "solid-js";
import { ClearIcon, SearchIcon, InstallIcon } from "../icons";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo";
import { automergeUrlToServiceWorkerUrl } from "@inkandswitch/patchwork-filesystem";
import { ViewRaw } from "./ViewRaw.tsx";
import { MODULE_FETCH_DEBOUNCE } from "../constants.ts";
import {
  getModuleEntryKind,
  type BranchesDoc,
  type ModuleEntry,
  type ModuleEntryKind,
} from "../utils/module-types.ts";

interface ModuleFiltersProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  filterPluginType: string;
  onPluginTypeChange: (value: string) => void;
  filterDataType: string;
  onDataTypeChange: (value: string) => void;
  uniquePluginTypes: string[];
  uniqueDataTypes: string[];
  repo: Repo;
  onAdd: (url: ModuleEntry) => void;
  isInstalled: (url: ModuleEntry) => boolean;
}

interface PackageInfo {
  name?: string;
  version?: string;
  plugins?: Array<{ id?: string; name?: string; type: string }>;
}

interface ModulePreview {
  kind: ModuleEntryKind | "direct";
  packageInfo?: PackageInfo;
  branchNames?: string[];
  error?: string;
}

export function ModuleFilters(props: ModuleFiltersProps) {
  const [isMobile, setIsMobile] = createSignal(window.innerWidth <= 768);
  const [isValid, setIsValid] = createSignal<boolean | null>(null);
  const [preview, setPreview] = createSignal<ModulePreview | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [previewUrl, setPreviewUrl] = createSignal<ModuleEntry | null>(null);

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const handleResize = () => {
    setIsMobile(window.innerWidth <= 768);
  };

  onMount(() => {
    window.addEventListener("resize", handleResize);
  });

  onCleanup(() => {
    window.removeEventListener("resize", handleResize);
    if (timeoutId) clearTimeout(timeoutId);
  });

  createEffect(() => {
    const value = props.searchQuery.trim();

    if (!value) {
      setIsValid(null);
      setPreview(null);
      setPreviewUrl(null);
      return;
    }

    const valid = isValidAutomergeUrl(value);
    const looksLikeModule = valid || /^(https?:\/\/|\.\/|\.\.\/|\/)/.test(value);
    setIsValid(looksLikeModule ? valid : null);

    if (!looksLikeModule) {
      setPreview(null);
      setPreviewUrl(null);
      return;
    }

    if (valid) {
      // Debounce the fetch
      if (timeoutId) clearTimeout(timeoutId);

      timeoutId = setTimeout(async () => {
        setIsLoading(true);
        setPreview(null);
        setPreviewUrl(value);

        try {
          const handle = await props.repo.find(value as AutomergeUrl);
          await handle.whenReady();
          const doc = handle.doc();

          if (!doc) {
            setPreview({
              kind: "unknown",
              error: "Document not found",
            });
            return;
          }

          const kind = getModuleEntryKind(doc);

          if (kind === "unknown") {
            setPreview({
              kind: "unknown",
              error:
                "Not a folder, directory, or branches doc (unsupported module type)",
            });
            return;
          }

          if (kind === "branches") {
            const branches = (doc as BranchesDoc).branches ?? {};
            setPreview({
              kind,
              branchNames: Object.keys(branches),
            });
            return;
          }

          // Folder/directory: try to fetch package.json for nicer preview.
          let packageInfo: PackageInfo | undefined;
          try {
            const packageJsonUrl = new URL(
              "package.json",
              new URL(
                automergeUrlToServiceWorkerUrl(value as AutomergeUrl),
                window.location.origin
              )
            ).href;

            const response = await fetch(packageJsonUrl);
            if (response.ok) {
              const pkgJson = await response.json();
              packageInfo = {
                name: pkgJson.name,
                version: pkgJson.version,
                plugins: pkgJson.plugins,
              };
            }
          } catch (err) {
            console.warn("Failed to fetch package.json:", err);
          }

          setPreview({
            kind,
            packageInfo,
          });
        } catch (error) {
          setPreview({
            kind: "unknown",
            error:
              error instanceof Error ? error.message : "Failed to fetch module",
          });
        } finally {
          setIsLoading(false);
        }
      }, MODULE_FETCH_DEBOUNCE);
    } else {
      if (timeoutId) clearTimeout(timeoutId);

      timeoutId = setTimeout(async () => {
        setIsLoading(true);
        setPreview(null);
        setPreviewUrl(value);

        try {
          const module = await import(/* @vite-ignore */ value);
          setPreview({
            kind: "direct",
            packageInfo: extractPackageInfo(module),
          });
        } catch (error) {
          setPreview({
            kind: "direct",
            error:
              error instanceof Error
                ? error.message
                : "Failed to import module",
          });
        } finally {
          setIsLoading(false);
        }
      }, MODULE_FETCH_DEBOUNCE);
    }
  });

  const handleAdd = () => {
    const value = props.searchQuery.trim();
    if (canInstall() && value) {
      props.onAdd(value);
      props.onSearchChange("");
      setIsValid(null);
      setPreview(null);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && canInstall() && props.searchQuery.trim()) {
      e.preventDefault();
      handleAdd();
    }
  };

  const hasValidation = () =>
    Boolean(
      props.searchQuery.trim() &&
      (isValid() === false || isLoading() || preview() !== null)
    );

  const canInstall = () => isValid() === true || directImportSucceeded();

  const directImportSucceeded = () =>
    isValid() === false && preview()?.kind === "direct" && !preview()?.error;

  const showInstallUI = () => isValid() === true || directImportSucceeded();

  return (
    <div class="module-settings-manager__filter-bar">
      <div class="module-settings-module-input">
        <div
          class="module-settings-module-input__row"
          style={{ display: "flex", gap: "0.5rem", "align-items": "center" }}
        >
          <div
            class="module-settings-manager__search-container"
            style={{ flex: "1", "min-width": "0" }}
          >
            <Show
              when={!showInstallUI()}
              fallback={
                <InstallIcon class="module-settings-manager__search-icon" />
              }
            >
              <SearchIcon class="module-settings-manager__search-icon" />
            </Show>
            <input
              type="text"
              class="module-settings-manager__search"
              classList={{
                "module-input__field--has-validation": hasValidation(),
              }}
              placeholder={"tenfold... or automerge:..."}
              value={props.searchQuery}
              onInput={(e) => props.onSearchChange(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              autofocus
            />
            <Show when={props.searchQuery}>
              <ClearIcon
                class="module-settings-manager__clear-icon"
                onClick={() => {
                  props.onSearchChange("");
                  setIsValid(null);
                  setPreview(null);
                  setPreviewUrl(null);
                }}
              />
            </Show>
          </div>
          <Show when={showInstallUI()}>
            <button
              class="module-settings-module-input__add-button"
              onClick={handleAdd}
              disabled={
                !canInstall() ||
                isLoading() ||
                !props.searchQuery.trim() ||
                (previewUrl() !== null && props.isInstalled(previewUrl()!))
              }
              style={{
                display: "flex",
                "align-items": "center",
                gap: "0.5rem",
                "flex-shrink": "0",
              }}
            >
              <InstallIcon />
              <span>Install</span>
            </button>
          </Show>
        </div>

        <Show when={hasValidation()}>
          <div class="module-settings-module-input__validation">
            <Show when={isLoading()}>
              <div class="module-settings-module-input__loading">
                Loading module details...
              </div>
            </Show>

            <Show when={preview() && !isLoading()}>
              <div class="module-settings-module-input__preview">
                <Show when={preview()?.error}>
                  <div class="module-settings-module-input__preview-error">
                    ⚠️ {preview()?.error}
                  </div>
                </Show>
                <Show when={!preview()?.error}>
                  <Show when={preview()?.kind === "branches"}>
                    <div class="module-settings-module-input__package-info">
                      <div class="module-settings-module-input__package-row">
                        <span class="module-settings-module-input__package-label">
                          Branches:
                        </span>
                        <div class="module-settings-module-input__plugins">
                          <Show
                            when={preview()?.branchNames?.length}
                            fallback={
                              <span style={{ opacity: 0.6 }}>(empty)</span>
                            }
                          >
                            <For each={preview()?.branchNames}>
                              {(name) => (
                                <span class="module-settings-module-input__plugin-pill">
                                  {name}
                                </span>
                              )}
                            </For>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </Show>
                  <Show when={preview()?.packageInfo}>
                    <div class="module-settings-module-input__package-info">
                      <Show when={preview()?.packageInfo?.name}>
                        <div class="module-settings-module-input__package-row">
                          <span class="module-settings-module-input__package-label">
                            Name:
                          </span>
                          <span class="module-settings-module-input__package-value">
                            {preview()?.packageInfo?.name}
                          </span>
                        </div>
                      </Show>
                      <Show when={preview()?.packageInfo?.version}>
                        <div class="module-settings-module-input__package-row">
                          <span class="module-settings-module-input__package-label">
                            Version:
                          </span>
                          <span class="module-settings-module-input__package-value">
                            {preview()?.packageInfo?.version}
                          </span>
                        </div>
                      </Show>
                      <Show when={preview()?.packageInfo?.plugins?.length}>
                        <div class="module-settings-module-input__package-row">
                          <span class="module-settings-module-input__package-label">
                            Plugins:
                          </span>
                          <div class="module-settings-module-input__plugins">
                            <For each={preview()?.packageInfo?.plugins}>
                              {(plugin) => (
                                <span class="module-settings-module-input__plugin-pill">
                                  {plugin.name || plugin.id}
                                </span>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <Show
                    when={
                      preview()?.kind !== "branches" && !preview()?.packageInfo
                    }
                  >
                    <div class="module-settings-module-input__no-package">
                      {preview()?.kind === "directory"
                        ? "📁 Valid directory (no package.json found)"
                        : "📁 Valid folder (no package.json found)"}
                    </div>
                  </Show>
                  <Show when={previewUrl()}>
                    <div class="module-settings-module-input__actions">
                      <ViewRaw
                        url={previewUrl()!}
                        class="module-settings-module-input__view-raw-button"
                      />
                      <Show when={props.isInstalled(previewUrl()!)}>
                        <span class="module-settings-module-input__installed-pill">
                          Installed
                        </span>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={!showInstallUI()}>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <select
            class="module-settings-manager__filter-select"
            value={props.filterPluginType}
            onChange={(e) => props.onPluginTypeChange(e.currentTarget.value)}
          >
            <option value="">
              {isMobile() ? "Plugin Type" : "All Plugin Types"}
            </option>
            <For each={props.uniquePluginTypes}>
              {(type) => <option value={type}>{type}</option>}
            </For>
          </select>
          <select
            class="module-settings-manager__filter-select"
            value={props.filterDataType}
            onChange={(e) => props.onDataTypeChange(e.currentTarget.value)}
          >
            <option value="">
              {isMobile() ? "Data Type" : "All Data Types"}
            </option>
            <For each={props.uniqueDataTypes}>
              {(dataType) => <option value={dataType}>{dataType}</option>}
            </For>
          </select>
        </div>
      </Show>
    </div>
  );
}

function extractPackageInfo(module: unknown): PackageInfo | undefined {
  if (!module || typeof module !== "object") return undefined;
  const plugins = (module as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) return undefined;
  return {
    plugins: plugins.filter(isPackagePlugin),
  };
}

function isPackagePlugin(
  plugin: unknown
): plugin is { id?: string; name?: string; type: string } {
  return Boolean(plugin && typeof plugin === "object" && "type" in plugin);
}
