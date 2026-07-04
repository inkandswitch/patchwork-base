import {
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  isValidAutomergeUrl,
  type AutomergeUrl,
  type Repo,
} from "@automerge/automerge-repo";

/**
 * Reactively track the Automerge heads of the document at `url`, re-reading
 * whenever the document changes. Returns an empty array while the handle is
 * loading or when `url` isn't a valid Automerge URL.
 */
export function useDocHeads(
  repo: Repo,
  url: Accessor<string>
): Accessor<string[]> {
  const [handle] = createResource(
    () => (isValidAutomergeUrl(url()) ? (url() as AutomergeUrl) : undefined),
    (u) => repo.find(u)
  );

  const [heads, setHeads] = createSignal<string[]>([]);

  createEffect(() => {
    const h = handle();
    if (!h) {
      setHeads([]);
      return;
    }
    const update = () => setHeads([...h.heads()]);
    update();
    h.on("change", update);
    onCleanup(() => h.off("change", update));
  });

  return heads;
}
