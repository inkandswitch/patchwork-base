import { useDocHandle } from "@automerge/automerge-repo-solid-primitives";
import type { Repo } from "@automerge/automerge-repo";
import type { AutomergeUrl } from "@automerge/vanillajs";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { OpenDocumentEvent } from "@inkandswitch/patchwork-elements";

interface UseSelectedViewParams {
  element: HTMLElement | ShadowRoot;
  repo: Repo;
}

/**
 * Manages selected document state, annotations subscription, and document events
 */
export function useSelectedView({ element, repo }: UseSelectedViewParams) {
  const [selectedView, setSelectedView] = createSignal<
    { url: AutomergeUrl; toolId?: string } | undefined
  >(undefined);

  const selectedDocHandle = useDocHandle(() => selectedView()?.url, { repo });

  // Listen to open document events
  onMount(() => {
    const onOpenDocument = (event: OpenDocumentEvent) => {
      event.stopPropagation();
      setSelectedView({ url: event.detail.url, toolId: event.detail.toolId });
    };

    element.addEventListener(
      "patchwork:open-document",
      onOpenDocument as EventListener
    );

    onCleanup(() => {
      element.removeEventListener(
        "patchwork:open-document",
        onOpenDocument as EventListener
      );
    });
  });

  // Add current handle to window for debugging
  createEffect(() => {
    (window as any).currentDocHandle = selectedDocHandle;
  });

  return selectedView;
}
