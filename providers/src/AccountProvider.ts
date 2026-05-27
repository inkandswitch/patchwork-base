import {
  type AutomergeUrl,
  type DocHandle,
  type Repo,
} from "@automerge/automerge-repo";
import {
  provide,
  type RequestEvent,
} from "@inkandswitch/patchwork-providers";

const CONTACT_SELECTOR = "patchwork:contact-dochandle";

/**
 * Minimal slice of the account doc this provider reads. The frame's full
 * `AccountDoc` carries many more fields; we deliberately read only
 * `contactUrl` so we don't have to keep this type in sync.
 */
type AccountDocLike = {
  contactUrl?: AutomergeUrl;
};

/**
 * Account provider component. Answers per-subdoc requests on the booted
 * site's account document so descendant tools don't have to reach for
 * `window.accountDocHandle` directly.
 *
 * Currently answers:
 *
 * - `patchwork:contact-dochandle` → resolves to a `DocHandle` for the
 *   current user's contact doc (`accountDoc.contactUrl`). If `contactUrl`
 *   hasn't been populated yet (the frame creates it lazily on first
 *   mount), the response is held until the field appears on the account
 *   doc.
 *
 * Other account subdocs (`rootFolderUrl`, `moduleSettingsUrl`) are
 * intentionally not exposed — they should be passed explicitly to tools
 * that need them.
 */
export const AccountProvider = (element: HTMLElement) => {
  const repo = (window as unknown as { repo?: Repo }).repo;
  const accountDocHandle = (
    window as unknown as {
      accountDocHandle?: DocHandle<AccountDocLike>;
    }
  ).accountDocHandle;
  if (!repo || !accountDocHandle) {
    console.warn(
      "[providers/account] window.repo or window.accountDocHandle missing; account provider disabled"
    );
    return () => {};
  }

  const onRequest = (event: RequestEvent) => {
    if (event.detail.type !== CONTACT_SELECTOR) return;
    provide<DocHandle<unknown>>(event, resolveContactHandle(repo, accountDocHandle));
  };

  element.addEventListener("patchwork:request", onRequest);

  return () => {
    element.removeEventListener("patchwork:request", onRequest);
  };
};

/**
 * Resolve the current contact `DocHandle`, waiting for `contactUrl` to
 * appear on the account doc if it isn't there yet. Each request gets its
 * own change listener that is removed as soon as the field shows up.
 */
function resolveContactHandle(
  repo: Repo,
  accountDocHandle: DocHandle<AccountDocLike>
): Promise<DocHandle<unknown>> | DocHandle<unknown> {
  const immediate = accountDocHandle.doc()?.contactUrl;
  if (immediate) return repo.find<unknown>(immediate);

  return new Promise<DocHandle<unknown>>((resolve) => {
    const check = () => {
      const url = accountDocHandle.doc()?.contactUrl;
      if (!url) return;
      accountDocHandle.off("change", check);
      resolve(repo.find<unknown>(url));
    };
    accountDocHandle.on("change", check);
  });
}
