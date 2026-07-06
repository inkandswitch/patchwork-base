import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  getRegistry,
  registerPlugins,
  type LoadablePlugin,
  type PluginDescription,
} from "@inkandswitch/patchwork-plugins";
import {
  parseAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";

export interface ContributedPlugin {
  type: string;
  id?: string;
}

/**
 * Two automerge URLs refer to the same document if their documentIds match,
 * regardless of versioning (heads). The plugin registry stores versioned URLs
 * (e.g. branches resolve to a folder URL with heads), while the page knows
 * the unversioned URL — compare by documentId to bridge that.
 */
export function sameAutomergeDoc(
  a: string | undefined,
  b: string | undefined
): boolean {
  if (!a || !b) return false;
  try {
    const ad = parseAutomergeUrl(a as AutomergeUrl).documentId;
    const bd = parseAutomergeUrl(b as AutomergeUrl).documentId;
    return !!ad && ad === bd;
  } catch {
    return false;
  }
}

/**
 * Remove every registry entry whose (type, id) matches one of the given
 * contributions, regardless of which importUrl it was registered from. Used
 * when a package's contributions change so old or shadowing registrations
 * don't outlive their source.
 */
export function unregisterContributions(plugins: ContributedPlugin[]) {
  for (const plugin of plugins) {
    if (!plugin.id) continue;
    getRegistry(plugin.type).remove(plugin.id);
  }
}

/**
 * Evict any current registration for this plugin's id, then re-register it
 * from the given importUrl so the viewed package becomes the live one.
 * Pass the resolved folder URL — for branches, that's the doc the branch
 * points at, not the branches doc itself.
 */
export function forceActivatePlugin(
  plugin: PluginDescription,
  importUrl: string
) {
  if (!plugin.id || !importUrl) return;
  getRegistry(plugin.type).remove(plugin.id);
  registerPlugins(
    [plugin as LoadablePlugin<PluginDescription>],
    importUrl
  );
}

/** Reactive importUrl of the currently registered plugin for (type, id). */
export function useActiveImportUrl(
  type: Accessor<string | undefined>,
  id: Accessor<string | undefined>
): Accessor<string | undefined> {
  const [active, setActive] = createSignal<string | undefined>();
  createEffect(() => {
    const t = type();
    const i = id();
    if (!t || !i) {
      setActive(undefined);
      return;
    }
    const reg = getRegistry(t);
    const refresh = () => setActive(reg.get(i)?.importUrl);
    refresh();
    const off = reg.on("changed", refresh);
    onCleanup(off);
  });
  return active;
}

export type PluginStatus = "active" | "shadowed" | "inactive" | "unknown";

/**
 * Reactive activation status of a (type, id) plugin relative to `sourceUrl`:
 * "active" if it's the live registration, "shadowed" if something else is
 * live but this source could take over, "inactive" if nothing is registered.
 */
export function usePluginStatus(
  type: Accessor<string | undefined>,
  id: Accessor<string | undefined>,
  sourceUrl: Accessor<string | undefined>
): Accessor<PluginStatus> {
  const activeImportUrl = useActiveImportUrl(type, id);
  return createMemo<PluginStatus>(() => {
    if (!id()) return "unknown";
    const active = activeImportUrl();
    if (!active) return "inactive";
    const source = sourceUrl();
    if (active === source || sameAutomergeDoc(active, source)) {
      return "active";
    }
    return "shadowed";
  });
}
