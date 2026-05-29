import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
  type ChangeFn,
  type Doc,
  type DocHandle,
  type DocumentId,
  type Patch,
  type UrlHeads,
} from "@automerge/automerge-repo";
import type { ChangeOptions } from "@automerge/automerge";

import type { DraftRepo } from "./repo.js";

const FORWARDED_EVENTS = [
  "change",
  "heads-changed",
  "delete",
  "ephemeral-message",
  "ephemeral-message-outbound",
  "remote-heads",
] as const;

type Listener = (...args: unknown[]) => void;

export type DraftedDocHandleOpts<T> = {
  draft: DraftRepo;
  originalUrl: AutomergeUrl;
  originalHandle: DocHandle<T>;
  cloneHandle: DocHandle<T> | null;
  forkHeads: UrlHeads | null;
};

// Proxy handle returned by `DraftRepo.find`. `url`/`documentId` always
// report the original URL; on a non-root draft, the first write triggers
// COW and subsequent reads/writes go to the clone.
export class DraftedDocHandle<T> {
  readonly #draft: DraftRepo;
  readonly #originalUrl: AutomergeUrl;
  readonly #originalHandle: DocHandle<T>;
  #cloneHandle: DocHandle<T> | null;
  #forkHeads: UrlHeads | null;
  readonly #listeners = new Map<string, Set<Listener>>();
  #forwarders: Array<{ ev: string; fn: Listener }> = [];

  constructor(opts: DraftedDocHandleOpts<T>) {
    this.#draft = opts.draft;
    this.#originalUrl = opts.originalUrl;
    this.#originalHandle = opts.originalHandle;
    this.#cloneHandle = opts.cloneHandle;
    this.#forkHeads = opts.forkHeads;
    this.#wireForwarders(this.#active);
  }

  get url(): AutomergeUrl {
    return this.#originalUrl;
  }

  get documentId(): DocumentId {
    return parseAutomergeUrl(this.#originalUrl).documentId;
  }

  get cloneUrl(): AutomergeUrl | null {
    if (!this.#cloneHandle || !this.#forkHeads) return null;
    return stringifyAutomergeUrl({
      documentId: parseAutomergeUrl(this.#cloneHandle.url).documentId,
      heads: this.#forkHeads,
    });
  }

  get #active(): DocHandle<T> {
    return this.#cloneHandle ?? this.#originalHandle;
  }

  get state() {
    return this.#active.state;
  }

  isReady = (): boolean => this.#active.isReady();
  isUnloaded = (): boolean => this.#active.isUnloaded();
  isDeleted = (): boolean => this.#active.isDeleted();
  isUnavailable = (): boolean => this.#active.isUnavailable();

  inState(states: Parameters<DocHandle<T>["inState"]>[0]): boolean {
    return this.#active.inState(states);
  }

  whenReady(states?: Parameters<DocHandle<T>["whenReady"]>[0]): Promise<void> {
    return this.#active.whenReady(states);
  }

  doc(): Doc<T> {
    return this.#active.doc();
  }
  docSync(): Doc<T> {
    return this.#active.docSync();
  }
  heads(): UrlHeads {
    return this.#active.heads();
  }
  history(): UrlHeads[] {
    return this.#active.history();
  }
  metadata(change?: string): ReturnType<DocHandle<T>["metadata"]> {
    return this.#active.metadata(change);
  }
  view(heads: UrlHeads): DocHandle<T> {
    return this.#active.view(heads);
  }
  forkSnapshot(): DocHandle<T> | null {
    if (!this.#cloneHandle || !this.#forkHeads) return null;
    return this.#cloneHandle.view(this.#forkHeads);
  }
  isReadOnly(): boolean {
    return this.#active.isReadOnly();
  }
  metrics(): ReturnType<DocHandle<T>["metrics"]> {
    return this.#active.metrics();
  }
  ref(
    ...segments: Parameters<DocHandle<T>["ref"]>
  ): ReturnType<DocHandle<T>["ref"]> {
    return (
      this.#active.ref as (
        ...a: Parameters<DocHandle<T>["ref"]>
      ) => ReturnType<DocHandle<T>["ref"]>
    )(...segments);
  }
  getRemoteHeads(
    storageId: Parameters<DocHandle<T>["getRemoteHeads"]>[0]
  ): ReturnType<DocHandle<T>["getRemoteHeads"]> {
    return this.#active.getRemoteHeads(storageId);
  }
  getSyncInfo(
    storageId: Parameters<DocHandle<T>["getSyncInfo"]>[0]
  ): ReturnType<DocHandle<T>["getSyncInfo"]> {
    return this.#active.getSyncInfo(storageId);
  }
  broadcast(message: unknown): void {
    this.#active.broadcast(message);
  }

  diff(): Patch[];
  diff(first: UrlHeads | DocHandle<T>, second?: UrlHeads): Patch[];
  diff(first?: UrlHeads | DocHandle<T>, second?: UrlHeads): Patch[] {
    if (first === undefined) {
      if (!this.#cloneHandle || !this.#forkHeads) return [];
      // Two-arg form: `DocHandle.diff(from)` reverses (`from = current, to = arg`),
      // which would flip splice/del.
      return this.#cloneHandle.diff(this.#forkHeads, this.#cloneHandle.heads());
    }
    return this.#active.diff(first as UrlHeads | DocHandle<T>, second);
  }

  change(callback: ChangeFn<T>, options?: ChangeOptions<T>): void {
    this.#triggerCOW();
    this.#active.change(callback, options);
  }

  changeAt(
    heads: UrlHeads,
    callback: ChangeFn<T>,
    options?: ChangeOptions<T>
  ): UrlHeads | undefined {
    this.#triggerCOW();
    return this.#active.changeAt(heads, callback, options);
  }

  merge(other: DocHandle<T>): void {
    this.#triggerCOW();
    const inner =
      other instanceof DraftedDocHandle
        ? ((other as DraftedDocHandle<T>).#active as DocHandle<T>)
        : other;
    this.#active.merge(inner);
  }

  on(ev: string, fn: Listener): this {
    let set = this.#listeners.get(ev);
    if (!set) {
      set = new Set();
      this.#listeners.set(ev, set);
    }
    set.add(fn);
    return this;
  }

  off(ev: string, fn: Listener): this {
    this.#listeners.get(ev)?.delete(fn);
    return this;
  }

  once(ev: string, fn: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(ev, wrapper);
      fn(...args);
    };
    return this.on(ev, wrapper);
  }

  addListener(ev: string, fn: Listener): this {
    return this.on(ev, fn);
  }

  removeListener(ev: string, fn: Listener): this {
    return this.off(ev, fn);
  }

  removeAllListeners(ev?: string): this {
    if (ev) this.#listeners.get(ev)?.clear();
    else this.#listeners.clear();
    return this;
  }

  emit(ev: string, ...args: unknown[]): boolean {
    const set = this.#listeners.get(ev);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) fn(...args);
    return true;
  }

  #triggerCOW(): void {
    if (this.#cloneHandle) return;
    const heads = this.#originalHandle.heads();
    const cloned = this.#draft.repo.clone(this.#originalHandle);
    this.#cloneHandle = cloned;
    this.#forkHeads = heads;

    this.#unwireForwarders(this.#originalHandle);
    this.#wireForwarders(cloned);

    const cloneUrl = stringifyAutomergeUrl({
      documentId: parseAutomergeUrl(cloned.url).documentId,
      heads,
    });
    this.#draft._recordClone(this.#originalUrl, cloneUrl, heads);

    // Synthetic nudge so reactive consumers re-read `doc()` immediately
    // instead of waiting for an incidental change on the clone.
    const before = this.#originalHandle.doc();
    const after = cloned.doc();
    this.emit("change", {
      handle: this,
      doc: after,
      patches: [] as Patch[],
      patchInfo: { before, after, source: "change" },
    });
    this.emit("heads-changed", { handle: this, doc: after });
  }

  #wireForwarders(target: DocHandle<T>): void {
    for (const ev of FORWARDED_EVENTS) {
      const fn: Listener = (payload: unknown) => {
        if (
          payload &&
          typeof payload === "object" &&
          "handle" in (payload as Record<string, unknown>)
        ) {
          this.emit(ev, { ...(payload as object), handle: this });
        } else {
          this.emit(ev, payload);
        }
      };
      this.#forwarders.push({ ev, fn });
      (target as unknown as { on(ev: string, fn: Listener): void }).on(ev, fn);
    }
  }

  #unwireForwarders(target: DocHandle<T>): void {
    for (const { ev, fn } of this.#forwarders) {
      (target as unknown as { off(ev: string, fn: Listener): void }).off(
        ev,
        fn
      );
    }
    this.#forwarders = [];
  }
}
