import type { AutomergeUrl, Repo } from "@automerge/automerge-repo";
import { useDocument } from "@automerge/automerge-repo-solid-primitives";
import {
  getType,
  type HasPatchworkMetadata,
} from "@inkandswitch/patchwork-filesystem";
import {
  getRegistry,
  isLoadedPlugin,
  type Datatype,
} from "@inkandswitch/patchwork-plugins";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

/**
 * The document title, rendered intrinsically by the frame (ported from the
 * standalone `document-title` tool): resolves the doc's datatype and asks it for
 * a title. Kept in the frame so the top bar owns its placement and sizing.
 */
export function DocumentTitle(props: {
  docUrl: Accessor<AutomergeUrl | undefined>;
  repo: Repo;
}) {
  const [doc] = useDocument<HasPatchworkMetadata>(() => props.docUrl(), {
    repo: props.repo,
  });
  const registry = getRegistry<Datatype>("patchwork:datatype");

  // Datatypes can register/load late; bump a version so the title recomputes.
  const [registryVersion, setRegistryVersion] = createSignal(0);
  onMount(() => {
    const off = registry.on("changed", () => setRegistryVersion((v) => v + 1));
    onCleanup(off);
  });

  const typeId = createMemo(() => {
    const d = doc();
    return d ? getType(d) : undefined;
  });

  // Ensure the datatype module is loaded so getTitle is callable.
  createEffect(() => {
    const id = typeId();
    if (id) void registry.load(id);
  });

  const title = createMemo(() => {
    registryVersion();
    const d = doc();
    const id = typeId();
    if (!d || !id) return undefined;
    const datatype = registry.get(id);
    if (!datatype || !isLoadedPlugin(datatype)) return undefined;
    return datatype.module.getTitle(d);
  });

  return <span class="threepane__title-text">{title() ?? "Untitled"}</span>;
}
