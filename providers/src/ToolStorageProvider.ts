import { type AutomergeUrl, type DocHandle, type Repo } from "@automerge/automerge-repo";
import { accept, type SubscribeEvent } from "@inkandswitch/patchwork-providers";
import type { PatchworkViewElement } from "@inkandswitch/patchwork-elements";

const TOOL_STORAGE_SELECTOR = "patchwork:tool-storage";

// Only the slice of the account doc this provider reads/writes.
type AccountDocLike = {
  toolStorage?: Record<string, AutomergeUrl>;
};

// De-dupes concurrent first-use creations for the same (account doc, toolId)
// pair, keyed by `${accountDocUrl}:${toolId}`, so two subscribers racing to
// initialize the same tool's storage don't each create their own doc.
const pendingCreates = new Map<string, Promise<AutomergeUrl>>();

/**
 * Answers `patchwork:tool-storage` subscriptions with the `AutomergeUrl` of a
 * private, per-tool doc scoped to the current account — created lazily on
 * first request and remembered under `accountDoc.toolStorage[toolId]`.
 *
 * This gives any tool (in particular ones with no `docUrl` of their own, e.g.
 * a `patchwork:component` context tool) a place to persist its own data
 * without reaching for globals like `window.accountDocHandle`. The doc's
 * contents belong entirely to the requesting tool; this provider only owns
 * the account-doc pointer and the lazy-create.
 *
 * Selector shape: `{ type: "patchwork:tool-storage", toolId: string }`.
 */
export const ToolStorageProvider = (element: PatchworkViewElement) => {
  const onSubscribe = (event: SubscribeEvent) => {
    if (event.detail.selector.type !== TOOL_STORAGE_SELECTOR) return;
    const { toolId } = event.detail.selector;
    if (typeof toolId !== "string" || !toolId) {
      console.warn(
        "[providers/tool-storage] subscription missing a string toolId"
      );
      return;
    }

    accept<AutomergeUrl>(event, (respond) => {
      let canceled = false;

      const view = element.closest<HTMLElement>("patchwork-view") ?? element;
      const accountDocUrl = view.getAttribute("doc-url") as AutomergeUrl | null;
      if (!accountDocUrl) {
        console.warn(
          "[providers/tool-storage] no doc-url on enclosing view; cannot resolve account doc"
        );
        return;
      }

      const repo = element.repo;

      void repo
        .find<AccountDocLike>(accountDocUrl)
        .then((accountDocHandle) =>
          ensureToolStorageUrl(repo, accountDocHandle, accountDocUrl, toolId)
        )
        .then((url) => {
          if (canceled || !url) return;
          respond(url);
        });

      return () => {
        canceled = true;
      };
    });
  };

  element.addEventListener("patchwork:subscribe", onSubscribe);

  return () => {
    element.removeEventListener("patchwork:subscribe", onSubscribe);
  };
};

// Resolve the tool's private storage doc, creating + linking it into
// `accountDoc.toolStorage[toolId]` on first use.
function ensureToolStorageUrl(
  repo: Repo,
  accountDocHandle: DocHandle<AccountDocLike>,
  accountDocUrl: AutomergeUrl,
  toolId: string
): Promise<AutomergeUrl> {
  const existing = accountDocHandle.doc()?.toolStorage?.[toolId];
  if (existing) return Promise.resolve(existing);

  const key = `${accountDocUrl}:${toolId}`;
  const inflight = pendingCreates.get(key);
  if (inflight) return inflight;

  const promise = repo
    .create2<Record<string, unknown>>({
      "@patchwork": { type: "patchwork:tool-storage" },
    })
    .then((handle) => {
      accountDocHandle.change((doc) => {
        if (!doc.toolStorage) doc.toolStorage = {};
        // Another caller may have won the race while ours was in flight.
        if (!doc.toolStorage[toolId]) doc.toolStorage[toolId] = handle.url;
      });
      return accountDocHandle.doc()?.toolStorage?.[toolId] ?? handle.url;
    })
    .finally(() => {
      pendingCreates.delete(key);
    });

  pendingCreates.set(key, promise);
  return promise;
}
