import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  onCleanup,
  type JSX,
} from "solid-js";
import "./styles.css";
import {
  useLiveRegistries,
  type RegistryEntry,
  type ToolElement,
  type ToolHandle,
} from "./registry.ts";
import {
  bareModuleUrl,
  classifyOrigin,
  documentIdOf,
  headsOf,
  isAutomergeUrl,
  moduleKey,
  moduleKeySet,
  ORIGIN_HINT,
  ORIGIN_LABEL,
  originRank,
  pinnedModuleUrl,
  type Origin,
} from "./origin.ts";
import { systemModuleKeys } from "./settings-sources.ts";
import { useDocHeadsMap } from "./doc-heads.ts";
import {
  discoverPlugins,
  discoverPackagePlugins,
  discoverHttpPlugins,
} from "./discover-plugins.ts";
import {
  packageDisplayName,
  resolvePackageInfo,
  resolvePackageMeta,
  type PkgInfo,
  type PkgMeta,
  type PluginLite,
} from "./pkg-meta.ts";

type View = "packages" | "registries" | "table";

// A registry *is* a plugin type, so the by-registry view reads as "by type".
const VIEW_LABEL: Record<View, string> = {
  packages: "By package",
  registries: "By type",
  table: "Table",
};

interface PackagePreview {
  meta: PkgMeta;
  plugins: PluginLite[] | null;
  error?: string;
}

// Preview what a URL would install. Automerge folder-docs go through the host
// worker; http(s) bundles are imported directly (see discoverHttpPlugins) —
// either way we read the module's real exported plugin descriptors, plus the
// package.json for name/version.
async function previewPackage(url: string): Promise<PackagePreview> {
  if (isAutomergeUrl(url)) {
    const bare = bareModuleUrl(url);
    const [pluginsResult, meta] = await Promise.all([
      discoverPlugins(bare).then(
        (plugins) => ({ plugins }) as const,
        (e) =>
          ({
            error: e instanceof Error ? e.message : "Couldn't read the package.",
          }) as const
      ),
      resolvePackageMeta(bare).catch(() => ({}) as PkgMeta),
    ]);
    return {
      meta,
      plugins: "plugins" in pluginsResult ? pluginsResult.plugins : null,
      error: "error" in pluginsResult ? pluginsResult.error : undefined,
    };
  }
  // http(s): import the entry module for real descriptors (mirrors the automerge
  // worker path); read package.json in parallel for name/version and as a
  // declared-plugins fallback when the import returns none or fails.
  const [pluginsResult, info] = await Promise.all([
    discoverHttpPlugins(url).then(
      (plugins) => ({ plugins }) as const,
      (e) =>
        ({
          error: e instanceof Error ? e.message : "Couldn't import the package.",
        }) as const
    ),
    resolvePackageInfo(url).catch(
      () => ({ meta: {}, plugins: null }) as PkgInfo
    ),
  ]);
  const imported = "plugins" in pluginsResult ? pluginsResult.plugins : null;
  const declared = info.plugins;
  return {
    meta: info.meta,
    plugins: imported && imported.length ? imported : declared,
    // Only surface the import failure when there are no declared plugins to
    // show in its place.
    error:
      "error" in pluginsResult && !(declared && declared.length)
        ? pluginsResult.error
        : undefined,
  };
}
type OriginFilter = "all" | Origin;
type SortKey = "name" | "registry" | "id" | "package" | "origin";

interface Enriched extends RegistryEntry {
  origin: Origin;
  pkgMeta?: PkgMeta;
  pkgName: string;
}

interface PackageGroup {
  importUrl: string | undefined;
  name: string;
  meta?: PkgMeta;
  origin: Origin;
  plugins: Enriched[];
}

function datatypesLabel(dt: string | string[] | undefined): string | null {
  if (dt === undefined) return null;
  if (typeof dt === "string") return dt === "*" ? "any" : dt;
  if (dt.includes("*")) return "any";
  if (dt.length === 0) return "none";
  return dt.join(", ");
}

function prettyType(type: string): string {
  const [ns, rest] = type.includes(":") ? type.split(/:(.*)/) : ["", type];
  return ns === "patchwork" ? rest : type;
}

// Render a list, but only the first `limit` items until "show more" is clicked.
// The toggle is a <li> so it sits validly inside the surrounding <ul>.
function Collapsible<T>(props: {
  each: T[];
  limit?: number;
  render: (item: T) => JSX.Element;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const limit = () => props.limit ?? 4;
  const shown = createMemo(() =>
    expanded() ? props.each : props.each.slice(0, limit())
  );
  const hidden = () => Math.max(0, props.each.length - limit());
  return (
    <>
      <For each={shown()}>{(item) => props.render(item)}</For>
      <Show when={hidden() > 0}>
        <li class="pw-more">
          <button
            class="pw-more__btn"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded() ? "show less" : `show ${hidden()} more`}
          </button>
        </li>
      </Show>
    </>
  );
}

export function Packages(props: {
  handle: ToolHandle;
  element: ToolElement;
}): JSX.Element {
  // --- the settings doc you're viewing (drives installed / core / ephemeral) -
  const [doc, setDoc] = createSignal(props.handle.doc());
  const onChange = () => setDoc(props.handle.doc());
  props.handle.on("change", onChange);
  onCleanup(() => props.handle.off("change", onChange));
  // Modules listed in the doc you're looking at → "installed".
  const installedKeys = createMemo(() => moduleKeySet(doc()?.modules));

  // --- the live registries ---------------------------------------------------
  const { snapshot } = useLiveRegistries();

  // Modules from the system/default settings doc(s) → "core"; an automerge
  // module in neither doc → "ephemeral". Re-read as plugins/manifests load.
  const viewedKey = createMemo(() => moduleKey(props.handle.url));
  const systemKeys = createMemo(() => {
    snapshot();
    return systemModuleKeys(viewedKey());
  });

  // Current heads per automerge module, looked up live from the repo — the
  // registry only stores a bare importUrl.
  const headsByDoc = useDocHeadsMap(() => snapshot().map((e) => e.importUrl));
  const headsFor = (importUrl: string | undefined): string[] => {
    if (!importUrl) return [];
    const embedded = headsOf(importUrl);
    if (embedded.length) return embedded;
    const id = documentIdOf(importUrl);
    return (id && headsByDoc()[id]) || [];
  };

  // --- broken modules: URLs in your package list that no plugin came from -----
  // (they're in the settings doc but registered nothing). We import each through
  // the worker to surface the failure — the danger boxes carry its stack.
  const pluginImportKeys = createMemo(() => {
    const keys = new Set<string>();
    for (const e of snapshot()) {
      const k = moduleKey(e.importUrl);
      if (k) keys.add(k);
    }
    return keys;
  });
  const orphanModules = createMemo(() => {
    const registered = pluginImportKeys();
    return (doc()?.modules ?? []).filter((m) => {
      const k = moduleKey(m);
      return !!k && !registered.has(k);
    });
  });

  interface Probe {
    status: "loading" | "error" | "ok";
    error?: string;
  }
  const [probes, setProbes] = createSignal<Record<string, Probe>>({});
  const probed = new Set<string>();
  createEffect(() => {
    for (const url of orphanModules()) {
      const key = moduleKey(url);
      if (!key || probed.has(key)) continue;
      probed.add(key);
      setProbes((p) => ({ ...p, [key]: { status: "loading" } }));
      // Automerge orphans probe via the worker; http(s) orphans via a direct
      // import (the worker only handles automerge, and would fail misleadingly).
      void discoverPackagePlugins(bareModuleUrl(url)).then(
        () => setProbes((p) => ({ ...p, [key]: { status: "ok" } })),
        (e) =>
          setProbes((p) => ({
            ...p,
            // discoverPlugins rejects with the worker's stack as the message.
            [key]: {
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            },
          }))
      );
    }
  });
  // Only the ones the worker actually failed to import — still-loading and
  // import-fine-but-registered-nothing modules aren't shown as broken.
  const brokenModules = createMemo(() =>
    orphanModules()
      .map((url) => ({ url, probe: probes()[moduleKey(url)!] }))
      .filter((b) => b.probe?.status === "error")
      .map((b) => ({ url: b.url, error: b.probe!.error ?? "Unknown error" }))
  );

  // --- package.json metadata, resolved lazily per importUrl ------------------
  const [pkgMetas, setPkgMetas] = createSignal<Record<string, PkgMeta>>({});
  const requested = new Set<string>();
  createEffect(() => {
    for (const entry of snapshot()) {
      const url = entry.importUrl;
      if (!url || requested.has(url)) continue;
      requested.add(url);
      void resolvePackageMeta(url).then((meta) =>
        setPkgMetas((prev) => ({ ...prev, [url]: meta }))
      );
    }
  });

  const enriched = createMemo<Enriched[]>(() => {
    const installed = installedKeys();
    const system = systemKeys();
    const metas = pkgMetas();
    return snapshot().map((entry) => {
      const meta = entry.importUrl ? metas[entry.importUrl] : undefined;
      return {
        ...entry,
        origin: classifyOrigin(entry.importUrl, installed, system),
        pkgMeta: meta,
        pkgName: packageDisplayName(entry.importUrl, meta),
      };
    });
  });

  // --- controls --------------------------------------------------------------
  const [view, setView] = createSignal<View>("packages");
  const [search, setSearch] = createSignal("");
  const [originFilter, setOriginFilter] = createSignal<OriginFilter>("all");
  const [sortKey, setSortKey] = createSignal<SortKey>("name");
  const [sortAsc, setSortAsc] = createSignal(true);

  const originCounts = createMemo(() => {
    const counts: Record<Origin, number> = {
      installed: 0,
      ephemeral: 0,
      core: 0,
      unknown: 0,
    };
    for (const e of enriched()) counts[e.origin]++;
    return counts;
  });

  const filtered = createMemo<Enriched[]>(() => {
    const q = search().trim().toLowerCase();
    const of = originFilter();
    return enriched().filter((e) => {
      if (of !== "all" && e.origin !== of) return false;
      if (q) {
        const hay = [
          e.name,
          e.id,
          e.registry,
          e.type,
          e.importUrl,
          e.pkgName,
          datatypesLabel(e.supportedDatatypes),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  const stats = createMemo(() => {
    const rows = filtered();
    const packages = new Set<string>();
    const registries = new Set<string>();
    for (const e of rows) {
      packages.add(e.importUrl ?? "∅");
      registries.add(e.registry);
    }
    return {
      plugins: rows.length,
      total: enriched().length,
      packages: packages.size,
      registries: registries.size,
    };
  });

  // --- grouped: by package ---------------------------------------------------
  const packageGroups = createMemo<PackageGroup[]>(() => {
    const groups = new Map<string, PackageGroup>();
    for (const e of filtered()) {
      const key = e.importUrl ?? "∅";
      let group = groups.get(key);
      if (!group) {
        group = {
          importUrl: e.importUrl,
          name: e.pkgName,
          meta: e.pkgMeta,
          origin: e.origin,
          plugins: [],
        };
        groups.set(key, group);
      }
      group.plugins.push(e);
    }
    const arr = [...groups.values()];
    for (const g of arr) g.plugins.sort((a, b) => a.name.localeCompare(b.name));
    arr.sort(
      (a, b) =>
        originRank(a.origin) - originRank(b.origin) ||
        a.name.localeCompare(b.name)
    );
    return arr;
  });

  // --- grouped: by registry --------------------------------------------------
  const registryGroups = createMemo(() => {
    const groups = new Map<string, Enriched[]>();
    for (const e of filtered()) {
      const list = groups.get(e.registry);
      if (list) list.push(e);
      else groups.set(e.registry, [e]);
    }
    return [...groups.entries()]
      .map(([registry, plugins]) => ({
        registry,
        plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.registry.localeCompare(b.registry));
  });

  // --- flat: table -----------------------------------------------------------
  const tableRows = createMemo<Enriched[]>(() => {
    const key = sortKey();
    const dir = sortAsc() ? 1 : -1;
    const value = (e: Enriched): string => {
      switch (key) {
        case "registry":
          return e.registry;
        case "id":
          return e.id;
        case "package":
          return e.pkgName;
        case "origin":
          return String(originRank(e.origin));
        default:
          return e.name;
      }
    };
    return [...filtered()].sort(
      (a, b) => value(a).localeCompare(value(b)) * dir || a.name.localeCompare(b.name)
    );
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey() === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  // --- click-to-copy ---------------------------------------------------------
  const [copied, setCopied] = createSignal<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = (value: string) => {
    try {
      void navigator.clipboard?.writeText(value);
    } catch {
      // clipboard may be unavailable; the click still gives visual feedback
    }
    setCopied(value);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopied(null), 1200);
  };
  onCleanup(() => clearTimeout(copyTimer));

  const openDoc = (url: string) => {
    props.element.dispatchEvent(
      new CustomEvent("patchwork:open-document", {
        detail: { url },
        bubbles: true,
        composed: true,
      })
    );
  };

  // Remove a module from the settings doc you're viewing. The doc stores bare
  // module URLs while a plugin's importUrl is heads-pinned, so match by key.
  const uninstall = (importUrl: string | undefined) => {
    const key = moduleKey(importUrl);
    if (!key) return;
    props.handle.change((d) => {
      if (!Array.isArray(d.modules)) return;
      const idx = d.modules.findIndex((m) => moduleKey(m) === key);
      if (idx >= 0) d.modules.splice(idx, 1);
    });
  };

  // Which per-source actions apply: automerge sources can be opened; anything
  // installed in the viewed doc can be deleted.
  const hasActions = (importUrl: string | undefined, origin: Origin) =>
    isAutomergeUrl(importUrl) || origin === "installed";

  // --- install-a-package modal ----------------------------------------------
  const [installOpen, setInstallOpen] = createSignal(false);
  const [installUrl, setInstallUrl] = createSignal("");
  const [installBusy, setInstallBusy] = createSignal(false);
  const [installPlugins, setInstallPlugins] = createSignal<
    PluginLite[] | null
  >(null);
  const [installMeta, setInstallMeta] = createSignal<PkgMeta | null>(null);
  const [installError, setInstallError] = createSignal<string | null>(null);

  const installTarget = createMemo(() => installUrl().trim());
  const isInstallableUrl = (url: string) => {
    if (isAutomergeUrl(url)) {
      const id = documentIdOf(url);
      return !!id && id.length >= 16;
    }
    if (/^https?:/i.test(url)) {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
  const installValid = createMemo(() => isInstallableUrl(installTarget()));
  const installKey = createMemo(() => moduleKey(installTarget()));
  const alreadyInstalled = createMemo(() => {
    const key = installKey();
    return !!key && installedKeys().has(key);
  });

  const resetPreview = () => {
    setInstallBusy(false);
    setInstallPlugins(null);
    setInstallMeta(null);
    setInstallError(null);
  };

  // Preview the pasted URL (debounced). Best-effort — a preview failure never
  // blocks installing a URL the user trusts.
  let previewToken = 0;
  createEffect(() => {
    if (!installOpen()) return;
    const raw = installTarget();
    resetPreview();
    if (!raw) return;
    if (!installValid()) {
      setInstallError("That doesn't look like an automerge: or https:// URL.");
      return;
    }
    const token = ++previewToken;
    setInstallBusy(true);
    const timer = setTimeout(() => {
      void previewPackage(raw).then((res) => {
        if (token !== previewToken) return; // a newer input superseded this
        setInstallBusy(false);
        setInstallMeta(res.meta);
        setInstallPlugins(res.plugins);
        if (res.error) setInstallError(res.error);
      });
    }, 350);
    onCleanup(() => clearTimeout(timer));
  });

  const closeInstall = () => {
    setInstallOpen(false);
    setInstallUrl("");
    resetPreview();
  };

  const doInstall = () => {
    const raw = installTarget();
    const key = installKey();
    if (!installValid() || !key) return;
    if (!alreadyInstalled()) {
      props.handle.change((d) => {
        if (!Array.isArray(d.modules)) d.modules = [];
        if (!d.modules.some((m) => moduleKey(m) === key)) d.modules.push(raw);
      });
    }
    closeInstall();
  };

  // Pasting a package URL into the filter is a shortcut to the install modal —
  // it opens pre-filled (and previewing) rather than filtering by the URL.
  // Returns true when the value was consumed as a URL so the caller can clear
  // the input's DOM value: setSearch("") alone won't remove the pasted URL when
  // search() is already "" (Solid skips the no-op `value` update, so the URL
  // stays visible in the filter box).
  const onSearchInput = (value: string): boolean => {
    const trimmed = value.trim();
    if (isInstallableUrl(trimmed)) {
      setSearch("");
      setInstallUrl(trimmed);
      setInstallOpen(true);
      return true;
    }
    setSearch(value);
    return false;
  };

  // --- small building blocks -------------------------------------------------
  const OriginBadge = (p: { origin: Origin }) => (
    <span
      class="pw-packages__origin"
      data-origin={p.origin}
      title={ORIGIN_HINT[p.origin]}
    >
      {ORIGIN_LABEL[p.origin]}
    </span>
  );

  const Copyable = (p: {
    value: string;
    label?: string;
    class?: string;
    title?: string;
  }) => (
    <code
      class={`pw-packages__copy ${p.class ?? ""}`}
      classList={{ "is-copied": copied() === p.value }}
      title={p.title ?? "Click to copy"}
      onClick={() => copy(p.value)}
    >
      {copied() === p.value ? "copied!" : p.label ?? p.value}
    </code>
  );

  const PluginRow = (p: { plugin: Enriched }) => {
    const dts = () => datatypesLabel(p.plugin.supportedDatatypes);
    return (
      <li class="pw-plugin">
        <span class="pw-plugin__dot" data-origin={p.plugin.origin} />
        <span class="pw-plugin__name">{p.plugin.name}</span>
        <span class="pw-plugin__type">{prettyType(p.plugin.type)}</span>
        <Copyable value={p.plugin.id} class="pw-plugin__id" title="Plugin id — click to copy" />
        <Show when={dts()}>
          <span class="pw-plugin__supports">
            <span class="pw-plugin__supports-label">supports</span> {dts()}
          </span>
        </Show>
      </li>
    );
  };

  const SourceLine = (p: { importUrl: string | undefined }) => {
    const heads = () => headsFor(p.importUrl);
    const pinned = () => pinnedModuleUrl(p.importUrl!, heads());
    return (
      <Show
        when={p.importUrl}
        fallback={<span class="pw-source__none">no import url</span>}
      >
        <div class="pw-source__lines">
          <Copyable
            value={bareModuleUrl(p.importUrl!)}
            class="pw-source__url"
            title="importUrl — click to copy"
          />
          <Show when={pinned()}>
            <Copyable
              value={pinned()!}
              label={`heads ${heads()
                .map((h) => h.slice(0, 7))
                .join(" ")}`}
              class="pw-source__heads"
              title="Copy URL pinned to these heads"
            />
          </Show>
        </div>
      </Show>
    );
  };

  // The right-aligned action group: open (automerge sources) + delete (anything
  // installed in the doc you're viewing).
  const SourceActions = (p: { importUrl: string | undefined; origin: Origin }) => (
    <Show when={hasActions(p.importUrl, p.origin)}>
      <div class="pw-actions">
        <Show when={isAutomergeUrl(p.importUrl)}>
          <button class="pw-actions__btn" onClick={() => openDoc(p.importUrl!)}>
            open
          </button>
        </Show>
        <Show when={p.origin === "installed"}>
          <button
            class="pw-actions__btn pw-actions__btn--danger"
            title="Remove this module from the settings doc you're viewing"
            onClick={() => uninstall(p.importUrl)}
          >
            delete
          </button>
        </Show>
      </div>
    </Show>
  );

  // --- render ----------------------------------------------------------------
  return (
    <div class="pw-packages">
      <header class="pw-packages__head">
        <div class="pw-packages__toolbar">
          <input
            class="pw-packages__search"
            type="text"
            placeholder="Filter… or paste a URL to install"
            value={search()}
            onInput={(e) => {
              // Clear the DOM node directly when a URL was consumed — the
              // signal may already be "", so the value binding won't reset it.
              if (onSearchInput(e.currentTarget.value)) e.currentTarget.value = "";
            }}
          />
          <div class="pw-packages__stats">
            <span>
              <strong>{stats().plugins}</strong>
              <Show when={stats().plugins !== stats().total}>
                <span class="pw-packages__stat-of"> / {stats().total}</span>
              </Show>{" "}
              plugins
            </span>
            <span>
              <strong>{stats().packages}</strong> packages
            </span>
            <span>
              <strong>{stats().registries}</strong> types
            </span>
          </div>
        </div>

        <div class="pw-packages__tabbar">
          <div class="pw-packages__tabs" role="tablist">
            <For each={["packages", "registries", "table"] as View[]}>
              {(v) => (
                <button
                  class="pw-packages__tab"
                  data-active={view() === v ? "" : undefined}
                  onClick={() => setView(v)}
                >
                  {VIEW_LABEL[v]}
                </button>
              )}
            </For>
          </div>
          <div class="pw-packages__origins">
            <For
              each={
                [
                  ["all", "all"],
                  ["installed", ORIGIN_LABEL.installed],
                  ["core", ORIGIN_LABEL.core],
                  ["ephemeral", ORIGIN_LABEL.ephemeral],
                ] as [OriginFilter, string][]
              }
            >
              {([key, label]) => (
                <button
                  class="pw-packages__origin-chip"
                  data-origin={key === "all" ? undefined : key}
                  data-active={originFilter() === key ? "" : undefined}
                  title={key === "all" ? undefined : ORIGIN_HINT[key as Origin]}
                  onClick={() => setOriginFilter(key)}
                >
                  {label}
                  <Show when={key !== "all"}>
                    <span class="pw-packages__origin-count">
                      {originCounts()[key as Origin]}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </header>

      {/* ---- BROKEN MODULES (in your list, imported nothing) ---- */}
      <Show when={view() === "packages" && brokenModules().length > 0}>
        <div class="pw-broken">
          <For each={brokenModules()}>
            {(b) => (
              <div class="pw-broken__box" role="alert">
                <div class="pw-broken__head">
                  <span class="pw-broken__label">Failed to import</span>
                  <Copyable
                    value={b.url}
                    class="pw-broken__url"
                    title="module URL — click to copy"
                  />
                  <button
                    class="pw-actions__btn pw-actions__btn--danger pw-broken__remove"
                    title="Remove this module from your package list"
                    onClick={() => uninstall(b.url)}
                  >
                    remove
                  </button>
                </div>
                <pre class="pw-broken__trace">{b.error}</pre>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={filtered().length > 0}
        fallback={
          <div class="pw-packages__empty">
            <Show
              when={enriched().length > 0}
              fallback={<>No plugins are registered yet.</>}
            >
              Nothing matches these filters.
            </Show>
          </div>
        }
      >
        {/* ---- BY PACKAGE ---- */}
        <Show when={view() === "packages"}>
          <ul class="pw-cards">
            <For each={packageGroups()}>
              {(group) => (
                <li class="pw-card" data-origin={group.origin}>
                  <header class="pw-card__head">
                    <h2 class="pw-card__name">{group.name}</h2>
                    <div class="pw-card__badges">
                      <Show when={group.meta?.version}>
                        <span class="pw-card__version">v{group.meta!.version}</span>
                      </Show>
                      <OriginBadge origin={group.origin} />
                      <span class="pw-card__count">
                        {group.plugins.length} plugin
                        {group.plugins.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </header>
                  <Show when={group.meta?.name && group.meta?.name !== group.name}>
                    <div class="pw-card__pkgname">{group.meta!.name}</div>
                  </Show>
                  <div class="pw-card__source">
                    <SourceLine importUrl={group.importUrl} />
                  </div>
                  <ul class="pw-plugins">
                    <Collapsible
                      each={group.plugins}
                      render={(plugin) => <PluginRow plugin={plugin} />}
                    />
                  </ul>
                  <Show when={hasActions(group.importUrl, group.origin)}>
                    <footer class="pw-card__foot">
                      <SourceActions
                        importUrl={group.importUrl}
                        origin={group.origin}
                      />
                    </footer>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* ---- BY REGISTRY ---- */}
        <Show when={view() === "registries"}>
          <div class="pw-registries">
            <For each={registryGroups()}>
              {(group) => (
                <section class="pw-registry">
                  <header class="pw-registry__head">
                    <h2 class="pw-registry__name">{group.registry}</h2>
                    <span class="pw-registry__count">{group.plugins.length}</span>
                  </header>
                  <ul class="pw-reglist">
                    <Collapsible
                      each={group.plugins}
                      render={(plugin) => (
                        <li class="pw-regitem" data-origin={plugin.origin}>
                          <div class="pw-regitem__main">
                            <span class="pw-regitem__name">{plugin.name}</span>
                            <Copyable
                              value={plugin.id}
                              class="pw-regitem__id"
                              title="Plugin id — click to copy"
                            />
                            <OriginBadge origin={plugin.origin} />
                            <Show when={datatypesLabel(plugin.supportedDatatypes)}>
                              <span class="pw-regitem__supports">
                                supports {datatypesLabel(plugin.supportedDatatypes)}
                              </span>
                            </Show>
                          </div>
                          <div class="pw-regitem__source">
                            <span class="pw-regitem__pkg">{plugin.pkgName}</span>
                            <SourceLine importUrl={plugin.importUrl} />
                            <SourceActions
                              importUrl={plugin.importUrl}
                              origin={plugin.origin}
                            />
                          </div>
                        </li>
                      )}
                    />
                  </ul>
                </section>
              )}
            </For>
          </div>
        </Show>

        {/* ---- TABLE ---- */}
        <Show when={view() === "table"}>
          <div class="pw-table-wrap">
            <table class="pw-table">
              <thead>
                <tr>
                  <For
                    each={
                      [
                        ["name", "Name"],
                        ["registry", "Registry"],
                        ["id", "Id"],
                        ["package", "Package"],
                        ["origin", "Origin"],
                      ] as [SortKey, string][]
                    }
                  >
                    {([key, label]) => (
                      <th
                        class="pw-table__th"
                        data-sorted={sortKey() === key ? "" : undefined}
                        onClick={() => toggleSort(key)}
                      >
                        {label}
                        <Show when={sortKey() === key}>
                          <span class="pw-table__arrow">
                            {sortAsc() ? "▲" : "▼"}
                          </span>
                        </Show>
                      </th>
                    )}
                  </For>
                  <th class="pw-table__th pw-table__th--plain">importUrl</th>
                </tr>
              </thead>
              <tbody>
                <For each={tableRows()}>
                  {(e) => (
                    <tr class="pw-table__row" data-origin={e.origin}>
                      <td class="pw-table__name">
                        {e.name}
                        <Show when={datatypesLabel(e.supportedDatatypes)}>
                          <span class="pw-table__supports">
                            {datatypesLabel(e.supportedDatatypes)}
                          </span>
                        </Show>
                      </td>
                      <td class="pw-table__reg">{e.registry}</td>
                      <td>
                        <Copyable value={e.id} class="pw-table__id" />
                      </td>
                      <td class="pw-table__pkg">{e.pkgName}</td>
                      <td>
                        <OriginBadge origin={e.origin} />
                      </td>
                      <td class="pw-table__url">
                        <div class="pw-source">
                          <SourceLine importUrl={e.importUrl} />
                          <SourceActions importUrl={e.importUrl} origin={e.origin} />
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>

      {/* ---- INSTALL MODAL ---- */}
      <Show when={installOpen()}>
        <div
          class="pw-modal"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeInstall();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeInstall();
          }}
        >
          <div class="pw-install">
            <header class="pw-install__head">
              <h2 class="pw-install__title">Install a package</h2>
              <button
                class="pw-install__close"
                title="Close"
                onClick={closeInstall}
              >
                ×
              </button>
            </header>
            <p class="pw-install__blurb">
              Paste an <code>automerge:</code> or <code>https://</code> URL to add
              it to your package list.
            </p>
            <input
              ref={(el) => setTimeout(() => el.focus(), 0)}
              class="pw-install__input"
              type="text"
              spellcheck={false}
              autocomplete="off"
              placeholder="automerge:… or https://…"
              value={installUrl()}
              onInput={(e) => setInstallUrl(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && installValid() && !alreadyInstalled()) {
                  e.preventDefault();
                  doInstall();
                }
              }}
            />

            <Show when={installTarget()}>
              <div class="pw-install__preview">
                <Show when={installError()}>
                  <div class="pw-install__error">{installError()}</div>
                </Show>
                <Show when={installBusy()}>
                  <div class="pw-install__loading">Reading package…</div>
                </Show>
                <Show when={installValid() && (installMeta() || installPlugins())}>
                  <div class="pw-install__card">
                    <div class="pw-install__card-head">
                      <h3 class="pw-install__pkg">
                        {installMeta()?.title ||
                          installMeta()?.name ||
                          packageDisplayName(
                            bareModuleUrl(installTarget()),
                            installMeta() ?? undefined
                          )}
                      </h3>
                      <Show when={installMeta()?.version}>
                        <span class="pw-install__version">
                          v{installMeta()!.version}
                        </span>
                      </Show>
                    </div>
                    <Show
                      when={installPlugins() && installPlugins()!.length > 0}
                      fallback={
                        <Show when={!installBusy() && !installError()}>
                          <div class="pw-install__none">
                            {installPlugins()
                              ? "No plugins reported by this package."
                              : "Couldn't read this package's plugin list — you can still install it."}
                          </div>
                        </Show>
                      }
                    >
                      <ul class="pw-install__plugins">
                        <For each={installPlugins()!}>
                          {(p) => (
                            <li class="pw-install__plugin">
                              <span class="pw-install__plugin-name">
                                {p.name || p.id}
                              </span>
                              <Show when={p.type}>
                                <span class="pw-plugin__type">
                                  {prettyType(p.type!)}
                                </span>
                              </Show>
                              <Show when={datatypesLabel(p.supportedDatatypes)}>
                                <span class="pw-install__plugin-supports">
                                  supports {datatypesLabel(p.supportedDatatypes)}
                                </span>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            <footer class="pw-install__foot">
              <Show when={alreadyInstalled()}>
                <span class="pw-install__already">
                  Already in your package list
                </span>
              </Show>
              <button class="pw-install__cancel" onClick={closeInstall}>
                Cancel
              </button>
              <button
                class="pw-install__add"
                disabled={!installValid() || alreadyInstalled()}
                onClick={doInstall}
              >
                Add to my package list
              </button>
            </footer>
          </div>
        </div>
      </Show>
    </div>
  );
}
