import {
  ErrorBoundary,
  For,
  Show,
  createMemo,
  createSignal,
  mapArray,
} from "solid-js";
import {
  isValidAutomergeUrl,
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
import type {
  ModuleEntry,
  ModuleSettingsDocWithBranches,
} from "../utils/module-types.ts";
import {
  forceActivatePlugin,
  useActiveImportUrl,
  usePluginStatus,
} from "../utils/plugin-registry.ts";

interface PackageListProps {
  moduleUrls: ModuleEntry[];
  moduleStateMap: Map<string, ModuleLoadState>;
  filteredPlugins: EnrichedPlugin[];
  onRemoveModule: (url: ModuleEntry) => void;
  repo: Repo;
  settingsHandle: DocHandle<ModuleSettingsDocWithBranches>;
  /**
   * The current user's own module-settings doc, when it differs from
   * `settingsHandle` (i.e. when viewing a foreign settings doc). Lets each
   * card render a second "My branch" picker that writes user-local overrides.
   */
  userSettingsHandle?: DocHandle<ModuleSettingsDocWithBranches>;
}

function defaultState(url: ModuleEntry): ModuleLoadState {
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

  const lookupState = (url: ModuleEntry): ModuleLoadState =>
    props.moduleStateMap.get(String(url)) ?? defaultState(url);

  const lookupPlugins = (url: ModuleEntry): EnrichedPlugin[] =>
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
              userSettingsHandle={props.userSettingsHandle}
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
  userSettingsHandle?: DocHandle<ModuleSettingsDocWithBranches>;
  onRemove: () => void;
}

function PackageCard(props: PackageCardProps) {
  const [copiedUrl, copyUrl] = useCopyToClipboard();

  const url = () => props.state.url;
  const pkgInfo = () => props.state.pkgInfo;
  const folderUrl = () => props.state.folderUrl;
  const sourceUrl = () => folderUrl() ?? (url() as string);

  const pluginStatuses = mapArray(
    () => props.plugins,
    (plugin) => ({
      plugin,
      status: usePluginStatus(
        () => plugin.type,
        () => plugin.id,
        sourceUrl
      ),
    })
  );

  const inactivePlugins = createMemo(() =>
    pluginStatuses()
      .filter(({ plugin, status }) => plugin.id && status() !== "active")
      .map(({ plugin }) => plugin)
  );

  const activateAll = () => {
    const src = sourceUrl();
    if (!src) return;
    for (const plugin of inactivePlugins()) {
      forceActivatePlugin(plugin, src);
    }
  };

  const handleViewSource = (e: MouseEvent) => {
    const detail: OpenDocumentEventDetail = {
      url: url() as AutomergeUrl
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
    if (!isValidAutomergeUrl(url())) return url();
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
        <code
          class="msm-card__url"
          classList={{ "msm-card__url--copied": copiedUrl() === url() }}
          onClick={() => copyUrl(url())}
          title="Click to copy URL"
        >
          {copiedUrl() === url() ? "copied" : url()}
        </code>
      </header>

      <Show when={pkgInfo()?.version}>
        <div class="msm-card__meta">v{pkgInfo()?.version}</div>
      </Show>

      <Show when={isValidAutomergeUrl(url())}>
        <ModuleControls
          url={url() as AutomergeUrl}
          repo={props.repo}
          settingsHandle={props.settingsHandle}
          userSettingsHandle={props.userSettingsHandle}
          plugins={props.plugins}
        />
      </Show>

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
          <PluginList plugins={props.plugins} sourceUrl={folderUrl() ?? url()} />
        </div>
      </Show>

      <div class="msm-card__action-row">
        <div class="msm-card__action-row-left">
          <Show when={inactivePlugins().length > 0}>
            <button class="msm-card__activate-all" onClick={activateAll}>
              Activate all ({inactivePlugins().length})
            </button>
          </Show>
        </div>
        <div class="msm-card__action-row-right">
          <Show when={isValidAutomergeUrl(url())}>
            <button class="msm-card__text-btn" onClick={handleViewSource}>
              View source
            </button>
          </Show>
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
  url: ModuleEntry;
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

/** Cards show at most this many plugins before collapsing the rest. */
const PLUGIN_OVERFLOW_LIMIT = 4;

function PluginList(props: {
  plugins: EnrichedPlugin[];
  sourceUrl: string | undefined;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const visible = createMemo(() =>
    expanded() ? props.plugins : props.plugins.slice(0, PLUGIN_OVERFLOW_LIMIT)
  );
  const overflowCount = () =>
    Math.max(0, props.plugins.length - PLUGIN_OVERFLOW_LIMIT);

  return (
    <>
      <ul class="msm-card__plugins">
        <For each={visible()}>
          {(plugin) => (
            <PluginItem plugin={plugin} sourceUrl={props.sourceUrl} />
          )}
        </For>
      </ul>
      <Show when={overflowCount() > 0}>
        <button
          class="msm-card__plugins-overflow"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded()
            ? "Show fewer"
            : `Show ${overflowCount()} more plugin${
                overflowCount() === 1 ? "" : "s"
              }`}
        </button>
      </Show>
    </>
  );
}

function PluginItem(props: {
  plugin: EnrichedPlugin;
  sourceUrl: string | undefined;
}) {
  const [copiedId, copyId] = useCopyToClipboard();
  const activeImportUrl = useActiveImportUrl(
    () => props.plugin.type,
    () => props.plugin.id
  );
  const status = usePluginStatus(
    () => props.plugin.type,
    () => props.plugin.id,
    () => props.sourceUrl
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
          props.sourceUrl
        }
      >
        <button
          class="msm-plugin__activate"
          onClick={() =>
            forceActivatePlugin(props.plugin, props.sourceUrl as string)
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
