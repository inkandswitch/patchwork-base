import {
  encodeHeads,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  interpretAsDocumentId,
  type AnyDocumentId,
  type AutomergeUrl,
  type DocHandle,
  type DocumentId,
  type DocumentProgress,
  type QueryState,
  type Repo,
  type UrlHeads,
} from "@automerge/automerge-repo";
import type { RepoLike } from "@inkandswitch/patchwork-providers";

import type { DraftDoc } from "../draft-types.js";
import { DraftedDocHandle } from "./dochandle.js";

// Overlay repo scoped to a single draft doc. All writes to wrapped
// documents COW into `DraftDoc.clones` via `DraftedDocHandle`.
export class DraftRepo implements RepoLike {
  readonly repo: Repo;
  readonly draftHandle: DocHandle<DraftDoc>;
  readonly #wrapped = new Map<AutomergeUrl, DraftedDocHandle<unknown>>();

  constructor(repo: Repo, draftHandle: DocHandle<DraftDoc>) {
    this.repo = repo;
    this.draftHandle = draftHandle;
  }

  // Only already-wrapped handles are exposed; unknown ids fall through to
  // `findWithProgress` or `find` so consumers never see an un-wrapped handle.
  get handles(): Record<DocumentId, DocHandle<unknown>> {
    const out: Record<string, DocHandle<unknown>> = {};
    for (const [url, wrapped] of this.#wrapped) {
      const { documentId } = parseAutomergeUrl(url);
      out[documentId] = wrapped as unknown as DocHandle<unknown>;
    }
    return out;
  }

  // Reports `loading` until the wrapped handle is ready, even if the inner
  // progress is already `ready` — otherwise consumers would briefly see the
  // unwrapped handle and bypass COW.
  findWithProgress<T>(id: AnyDocumentId): DocumentProgress<T> {
    const original = anyIdToCanonicalUrl(id);
    const documentId = parseAutomergeUrl(original).documentId;
    const inner = this.repo.findWithProgress<T>(original);
    const wrappedPromise = this.find<T>(id);
    wrappedPromise.catch(() => {});

    const peek = (): QueryState<T> => {
      const innerState = inner.peek();
      if (innerState.state !== "ready") return innerState;
      const wrapped = this.#wrapped.get(original);
      if (!wrapped) {
        return { state: "loading", sources: innerState.sources };
      }
      return {
        state: "ready",
        handle: wrapped as unknown as DocHandle<T>,
        sources: innerState.sources,
      };
    };

    return {
      documentId,
      peek,
      subscribe: (callback) => {
        let last: string | null = null;
        const dispatch = () => {
          const state = peek();
          const sig =
            state.state === "failed"
              ? `failed:${state.error.message}`
              : state.state;
          if (sig === last) return;
          last = sig;
          callback(state);
        };
        const unsubscribeInner = inner.subscribe(dispatch);
        wrappedPromise.then(dispatch, dispatch);
        return unsubscribeInner;
      },
      whenReady: ({ signal } = {}) => {
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (!signal) return wrappedPromise;
        return new Promise<DocHandle<T>>((resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          wrappedPromise.then(
            (handle) => {
              signal.removeEventListener("abort", onAbort);
              resolve(handle);
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              reject(err);
            }
          );
        });
      },
      // Deprecated; kept for pre-`peek()` consumers.
      get state() {
        return peek().state;
      },
      get progress() {
        return inner.progress;
      },
      get error() {
        const s = peek();
        return s.state === "failed" ? s.error : undefined;
      },
    };
  }

  async find<T>(id: AnyDocumentId): Promise<DocHandle<T>> {
    const original = anyIdToCanonicalUrl(id);

    const cached = this.#wrapped.get(original);
    if (cached) return cached as unknown as DocHandle<T>;

    const originalHandle = await this.repo.find<T>(original);
    const cloneEntry = this.draftHandle.doc()?.clones?.[original];

    let cloneHandle: DocHandle<T> | null = null;
    let forkHeads: UrlHeads | null = null;
    if (cloneEntry) {
      cloneHandle = await this.repo.find<T>(canonicalUrl(cloneEntry.cloneUrl));
      forkHeads = cloneEntry.clonedAt;
    }

    const wrapped = new DraftedDocHandle<T>({
      draft: this,
      originalUrl: original,
      originalHandle,
      cloneHandle,
      forkHeads,
    });
    this.#wrapped.set(
      original,
      wrapped as unknown as DraftedDocHandle<unknown>
    );
    return wrapped as unknown as DocHandle<T>;
  }

  create<T>(initialValue?: T): DocHandle<T> {
    const handle = this.repo.create<T>(initialValue);
    this.#registerBornHere(handle.url);
    return handle;
  }

  async create2<T>(initialValue?: T): Promise<DocHandle<T>> {
    const handle = await this.repo.create2<T>(initialValue);
    this.#registerBornHere(handle.url);
    return handle;
  }

  // Self-clone so future writes skip COW: the dochandle treats a present
  // clone entry as "already cloned, write through".
  #registerBornHere(url: AutomergeUrl): void {
    this._recordClone(url, url, encodeHeads([]));
  }

  /** @internal */
  _recordClone(
    originalUrl: AutomergeUrl,
    cloneUrl: AutomergeUrl,
    clonedAt: UrlHeads
  ): void {
    this.draftHandle.change((d) => {
      d.clones[originalUrl] = { cloneUrl, clonedAt };
    });
  }
}

function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}

function anyIdToCanonicalUrl(id: AnyDocumentId): AutomergeUrl {
  return stringifyAutomergeUrl({ documentId: interpretAsDocumentId(id) });
}
