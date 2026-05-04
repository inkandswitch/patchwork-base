import { ErrorBoundary, For, Show, createMemo } from "solid-js";
import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import type { OpenDocumentEventDetail } from "@inkandswitch/patchwork-elements";
import { ModuleControls } from "./ModuleControls.tsx";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.ts";
import type {
  EnrichedPlugin,
  ModuleLoadState,
} from "../hooks/useModulePlugins.ts";
import type { ModuleSettingsDocWithBranches } from "../utils/module-types.ts";
import {
  forceActivatePlugin,
  sameAutomergeDoc,
  useActiveImportUrl,
} from "../utils/plugin-registry.ts";

interface PackageListProps {
  moduleUrls: AutomergeUrl[];
  moduleStateMap: Map<string, ModuleLoadState>;
  filteredPlugins: EnrichedPlugin[];
  onRemoveModule: (url: AutomergeUrl) => void;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
}

function defaultState(url: AutomergeUrl): ModuleLoadState {
  return { url, loading: true, error: undefined, plugins: [] };
}

export function PackageList(props: PackageListProps) {
  const filteredByModule = createMemo(() => {
    const map = new Map<string, EnrichedPlugin[]>();
    for (const plugin of props.filteredPlugins) {
      if (!plugin.importUrl) continue;
      const key = String(plugin.importUrl);
      const list = map.get(key);
      if (list) list.push(plugin);
      else map.set(key, [plugin]);
    }
    return map;
  });

  const lookupState = (url: AutomergeUrl): ModuleLoadState =>
    props.moduleStateMap.get(String(url)) ?? defaultState(url);

  const lookupPlugins = (url: AutomergeUrl): EnrichedPlugin[] =>
    filteredByModule().get(String(url)) ?? [];

  return (
    <ul class="msm-cards">
      <For each={props.moduleUrls}>
        {(url) => (
          <ErrorBoundary
            fallback={(err, reset) => (
              <PackageCardError
                url={url}
                error={err}
                onReset={reset}
                onRemove={() => props.onRemoveModule(url)}
              />
            )}
          >
            <PackageCard
              state={lookupState(url)}
              plugins={lookupPlugins(url)}
              repo={props.repo}
              settingsHandle={props.settingsHandle}
              onRemove={() => props.onRemoveModule(url)}
            />
          </ErrorBoundary>
        )}
      </For>
    </ul>
  );
}

interface PackageCardProps {
  state: ModuleLoadState;
  plugins: EnrichedPlugin[];
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  onRemove: () => void;
}

function PackageCard(props: PackageCardProps) {
  const [copiedUrl, copyUrl] = useCopyToClipboard();

  const url = () => props.state.url;
  const pkgInfo = () => props.state.pkgInfo;
  const folderUrl = () => props.state.folderUrl;

  const handleViewSource = (e: MouseEvent) => {
    const detail: OpenDocumentEventDetail = {
      url: url(),
      toolId: "raw",
    };
    (e.currentTarget as HTMLButtonElement).dispatchEvent(
      new CustomEvent("patchwork:open-document", {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  };

  const errorMessage = () => formatError(props.state.error);

  const displayName = () => {
    const info = pkgInfo();
    if (info?.title) return info.title;
    if (info?.name) return info.name;
    if (props.state.error) return "(failed to load)";
    if (props.state.loading) return "(loading…)";
    return "(unnamed package)";
  };

  return (
    <li
      class="msm-card"
      classList={{
        "msm-card--loading": props.state.loading && !props.state.pkgInfo,
        "msm-card--error": Boolean(props.state.error),
      }}
    >
      <header class="msm-card__heading">
        <h3 class="msm-card__name">{displayName()}</h3>
        <Show when={pkgInfo()?.version}>
          <div class="msm-card__meta">v{pkgInfo()?.version}</div>
        </Show>
      </header>

      <code
        class="msm-card__url"
        classList={{ "msm-card__url--copied": copiedUrl() === url() }}
        onClick={() => copyUrl(url())}
        title="Click to copy URL"
      >
        {copiedUrl() === url() ? "copied" : url()}
      </code>

      <Show when={errorMessage()}>
        <div class="msm-card__error">
          <strong>Failed to load:</strong> {errorMessage()}
        </div>
      </Show>

      <Show when={props.state.loading && !props.state.error && !pkgInfo()}>
        <div class="msm-card__loading">Loading…</div>
      </Show>

      <Show
        when={
          !props.state.loading &&
          !props.state.error &&
          props.state.plugins.length === 0
        }
      >
        <div class="msm-card__empty">No plugins contributed</div>
      </Show>

      <Show when={props.plugins.length > 0}>
        <div class="msm-card__contributes">
          <ul class="msm-card__plugins">
            <For each={props.plugins}>
              {(plugin) => (
                <PluginItem plugin={plugin} folderUrl={folderUrl()} />
              )}
            </For>
          </ul>
        </div>
      </Show>

      <div class="msm-card__action-row">
        <div class="msm-card__action-row-left">
          <ModuleControls
            url={url()}
            repo={props.repo}
            settingsHandle={props.settingsHandle}
            plugins={props.plugins}
          />
        </div>
        <div class="msm-card__action-row-right">
          <button class="msm-card__text-btn" onClick={handleViewSource}>
            View source
          </button>
          <button
            class="msm-card__text-btn msm-card__text-btn--danger"
            onClick={props.onRemove}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

function PackageCardError(props: {
  url: AutomergeUrl;
  error: unknown;
  onReset: () => void;
  onRemove: () => void;
}) {
  const [copiedUrl, copyUrl] = useCopyToClipboard();
  const message = () => formatError(props.error) ?? "unknown error";

  return (
    <li class="msm-card msm-card--error">
      <header class="msm-card__heading">
        <h3 class="msm-card__name">(failed to render)</h3>
      </header>
      <code
        class="msm-card__url"
        classList={{ "msm-card__url--copied": copiedUrl() === props.url }}
        onClick={() => copyUrl(props.url)}
        title="Click to copy URL"
      >
        {copiedUrl() === props.url ? "copied" : props.url}
      </code>
      <div class="msm-card__error">
        <strong>Render error:</strong> {message()}
      </div>
      <div class="msm-card__action-row">
        <div class="msm-card__action-row-right">
          <button class="msm-card__text-btn" onClick={props.onReset}>
            Try again
          </button>
          <button
            class="msm-card__text-btn msm-card__text-btn--danger"
            onClick={props.onRemove}
          >
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

function formatError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

function PluginItem(props: {
  plugin: EnrichedPlugin;
  folderUrl: AutomergeUrl | undefined;
}) {
  const [copiedId, copyId] = useCopyToClipboard();
  const activeImportUrl = useActiveImportUrl(
    () => props.plugin.type,
    () => props.plugin.id
  );
  const status = createMemo<"active" | "shadowed" | "inactive" | "unknown">(
    () => {
      if (!props.plugin.id) return "unknown";
      const active = activeImportUrl();
      if (!active) return "inactive";
      if (sameAutomergeDoc(active, props.folderUrl)) return "active";
      return "shadowed";
    }
  );
  return (
    <li class="msm-plugin">
      <div class="msm-plugin__row">
        <span
          class="msm-plugin__status"
          classList={{
            "msm-plugin__status--active": status() === "active",
            "msm-plugin__status--shadowed": status() === "shadowed",
            "msm-plugin__status--inactive": status() === "inactive",
          }}
          title={
            status() === "active"
              ? "active"
              : status() === "shadowed"
                ? `shadowed by: ${activeImportUrl()}`
                : status() === "inactive"
                  ? "not registered"
                  : "no id"
          }
        />
        <span class="msm-plugin__name">{props.plugin.name}</span>
        <Show when={props.plugin.id}>
          <code
            class="msm-plugin__id"
            classList={{
              "msm-plugin__id--copied": copiedId() === props.plugin.id,
            }}
            onClick={() => copyId(props.plugin.id)}
            title="Click to copy ID"
          >
            {copiedId() === props.plugin.id ? "copied" : props.plugin.id}
          </code>
        </Show>
      </div>
      <div class="msm-plugin__field">
        <span
          class="msm-plugin__type"
          classList={{
            [`msm-plugin__type--${props.plugin.type.replace(/:/g, "--")}`]: true,
            [`msm-plugin__type--${props.plugin.type.replace(/patchwork:/g, "")}`]: true,
          }}
        >
          {prettyType(props.plugin.type)}
        </span>
      </div>

      <Show when={props.plugin.datatypesDisplay.type !== "empty"}>
        <div class="msm-plugin__supports">
          <span class="msm-plugin__supports-label">supports</span>
          <For each={props.plugin.datatypesDisplay.values}>
            {(dt, i) => (
              <>
                <Show when={i() > 0}>
                  <span class="msm-plugin__supports-sep">,</span>
                </Show>
                <span
                  class="msm-plugin__supports-item"
                  classList={{
                    "msm-plugin__supports-item--any":
                      props.plugin.datatypesDisplay.type === "any",
                    "msm-plugin__supports-item--none":
                      props.plugin.datatypesDisplay.type === "none",
                  }}
                >
                  {dt}
                </span>
              </>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={
          (status() === "shadowed" || status() === "inactive") &&
          props.folderUrl
        }
      >
        <button
          class="msm-plugin__activate"
          onClick={() =>
            forceActivatePlugin(props.plugin, props.folderUrl as string)
          }
          title={
            status() === "shadowed"
              ? `Currently active from ${activeImportUrl()} — click to take over`
              : "Register this version as the live one"
          }
        >
          activate
        </button>
      </Show>
    </li>
  );
}

function prettyType(type: string) {
  if (type.startsWith("patchwork:")) return type.slice("patchwork:".length);
  return type;
}
