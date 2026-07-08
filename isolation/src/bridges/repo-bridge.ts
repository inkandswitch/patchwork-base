/**
 * Creates an ephemeral intermediary Repo that sits between the host's main
 * Repo and an isolated iframe's Repo. It enforces an allowlist of document
 * URLs — only documents the user has authorized can sync to the iframe.
 *
 * Access control uses `shareConfig` on the intermediary Repo with `access()`
 * and `announce()` callbacks that gate per-document sync:
 *  - `access`: gates ALL peers (including host) by allowlist — the intermediary
 *    never holds non-allowlisted documents in memory
 *  - `announce`: only announces allowlisted documents
 *
 * The intermediary has no persistent storage (`isEphemeral: true`).
 */
import {
  Repo,
  type AutomergeUrl,
  type PeerId,
  type DocumentId,
  type DocHandle,
  parseAutomergeUrl,
} from "@automerge/automerge-repo";
import { getChangesMetaSince } from "@automerge/automerge";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import { log } from "../log.js";

/**
 * A set of document IDs, addable by either automerge URL or raw document ID,
 * queryable by either. The allowlist and denylist are both just such sets
 * gated against by the intermediary repo's shareConfig — they differ only in
 * meaning, so they share this base. Kept as distinct named subclasses below so
 * the security-meaningful names (and their types) stay explicit at call sites.
 */
class SyncDocumentSet {
  #ids = new Set<DocumentId>();

  add(url: AutomergeUrl): void {
    const { documentId } = parseAutomergeUrl(url);
    this.#ids.add(documentId);
  }

  addDocumentId(documentId: DocumentId): void {
    this.#ids.add(documentId);
  }

  has(documentId: DocumentId): boolean {
    return this.#ids.has(documentId);
  }

  hasUrl(url: AutomergeUrl): boolean {
    const { documentId } = parseAutomergeUrl(url);
    return this.#ids.has(documentId);
  }

  get size(): number {
    return this.#ids.size;
  }
}

/**
 * Document IDs the iframe is allowed to sync. Used by the intermediary repo's
 * shareConfig to gate document access.
 */
export class SyncAllowlist extends SyncDocumentSet {}

/**
 * Document IDs that must never sync to the iframe, regardless of allowlist
 * status — the denylist takes precedence. Protects sensitive documents: the
 * account doc, module settings, tool/package source code, and branches docs.
 *
 * Unlike the allowlist, the denylist is populated asynchronously (it walks
 * documents to discover the protected set). Callers must not seed the allowlist
 * or sync anything to the iframe until it is fully populated, or a protected
 * doc could slip through before its entry lands. `setReady` records the
 * populate promise; `whenReady()` lets the boot path await it, and the
 * synchronous `isReady` flag lets the per-document sync gate fail closed
 * cheaply (see createIntermediaryRepo).
 */
export class SyncDenylist extends SyncDocumentSet {
  // A denylist with no population scheduled is trivially ready (empty but
  // complete). setReady() marks it not-ready until its populate promise lands.
  #ready: Promise<void> = Promise.resolve();
  isReady = true;

  /** Record the population promise; not ready until it resolves. */
  setReady(populated: Promise<void>): void {
    this.isReady = false;
    this.#ready = populated.then(() => {
      this.isReady = true;
    });
  }

  /** Resolves once population has completed. */
  whenReady(): Promise<void> {
    return this.#ready;
  }
}

export interface IntermediaryRepoOptions {
  /** The allowlist controlling which documents can sync to the host. */
  allowlist: SyncAllowlist;
  /** The host Repo to sync allowed documents from. */
  hostRepo: Repo;
  /** Optional denylist — denylisted documents are blocked regardless of allowlist. */
  denylist?: SyncDenylist;
  /**
   * The iframe repo's Automerge author id (generated host-side). An unallowlisted
   * document the iframe references that is resident in the intermediary (it
   * arrived over the open iframe channel) and whose changes are *all* authored by
   * this id was created by the iframe itself, so it is auto-allowlisted (no
   * prompt). See `resolveAccess`.
   */
  iframeAuthorId: string;
  /**
   * Called (out of band, never from the sync gate) for a document the iframe
   * requests that isn't allowlisted and wasn't created by the iframe — i.e. a
   * foreign document that did not arrive over the open iframe channel. If it
   * returns true, the document is added to the allowlist.
   */
  onAccessRequest?: (documentId: DocumentId) => Promise<boolean>;
}

export interface IntermediaryRepo {
  /** Port to hand to the iframe's Repo via MessageChannelNetworkAdapter. */
  iframePort: MessagePort;
  /** Tear down the intermediary repo and close all channels. */
  shutdown(): void;
}

/** The state reported by a `repo.findWithProgress(...)` query. */
type QueryState = ReturnType<ReturnType<Repo["findWithProgress"]>["peek"]>;

/**
 * Resolve to the first terminal (`ready` | `unavailable` | `failed`) state of a
 * `findWithProgress` query, acting exactly once. Peeks the current state first
 * (it may already be terminal), otherwise awaits the first terminal transition.
 * The `settled` guard protects against a synchronous subscribe callback firing
 * before `unsubscribe` is assigned.
 */
function firstTerminalState(
  progress: ReturnType<Repo["findWithProgress"]>
): Promise<QueryState> {
  return new Promise((resolve) => {
    let settled = false;
    const isTerminal = (s: QueryState) =>
      s.state === "ready" || s.state === "unavailable" || s.state === "failed";
    const tryResolve = (s: QueryState): boolean => {
      if (settled || !isTerminal(s)) return false;
      settled = true;
      resolve(s);
      return true;
    };
    if (tryResolve(progress.peek())) return;
    const unsubscribe = progress.subscribe((s) => {
      if (tryResolve(s)) unsubscribe();
    });
  });
}

/**
 * Create an intermediary repo gated by the caller-supplied allowlist and
 * denylist (both already seeded before this runs).
 *
 * Two MessageChannels are created:
 *  1. hostChannel — connects intermediary ↔ host repo
 *  2. iframeChannel — connects intermediary ↔ iframe repo
 *
 * The intermediary's `shareConfig` gates sync ASYMMETRICALLY by channel:
 *  - Host channel: denylist THEN allowlist — a doc crosses only if it is not
 *    denylisted AND is allowlisted. This is the security boundary; nothing
 *    denylisted or un-allowlisted enters/leaves the host graph.
 *  - Iframe channel: fully open — all docs sync both ways. Safe because the
 *    intermediary is ephemeral and its only other peer (the host) is gated, so
 *    it can only ever hold allowlisted docs + docs the iframe itself pushed. A
 *    denylisted doc can never enter the intermediary to reach the iframe.
 *
 * A document the iframe references that isn't yet allowlisted is DENIED by the
 * gate immediately and resolved out of band (see `resolveAccess` below): if the
 * iframe created it (it is resident and authored solely by the iframe) it is
 * auto-allowlisted; otherwise the user is prompted. Once decided, the gate is
 * re-run via `repo.shareConfigChanged()`. The gate itself never blocks on a
 * fetch or a prompt — doing so would stall the sync (see `hostChannelAllows`).
 */
export function createIntermediaryRepo(
  options: IntermediaryRepoOptions
): IntermediaryRepo {
  const { allowlist, hostRepo, denylist, iframeAuthorId, onAccessRequest } =
    options;

  const hostRepoPeerId = hostRepo.peerId;

  // Channel connecting intermediary ↔ host repo
  const hostChannel = new MessageChannel();
  const hostAdapter = new MessageChannelNetworkAdapter(hostChannel.port1, {
    useWeakRef: true,
  });

  // Channel connecting intermediary ↔ iframe repo
  const iframeChannel = new MessageChannel();
  const iframeAdapter = new MessageChannelNetworkAdapter(iframeChannel.port1, {
    useWeakRef: true,
  });

  // Whether a document may cross the HOST channel: it must NOT be denylisted and
  // MUST be allowlisted. This gate is a *fast, synchronous-return policy check*
  // over in-memory sets — it never awaits a document fetch or a user prompt.
  // automerge-repo holds a peer at sharePolicyState "loading" for as long as
  // `access` is unresolved, which would stall the sync (no doc-unavailable, no
  // content) — so any slow or interactive decision must happen out of band. An
  // undecided document is DENIED now; `resolveAccess` decides it in the
  // background and, once decided, calls `repo.shareConfigChanged()` to re-run
  // this gate and re-engage the waiting iframe peer (see the automerge team's
  // "immediately deny, prompt, then fire shareConfigChanged" guidance).
  //
  // While the denylist is still populating we fail closed (allow nothing to/from
  // the host) — the boot path awaits denylist readiness before this repo exists,
  // so this is defense in depth. This is the single security boundary; the
  // iframe channel is open.
  const hostChannelAllows = (documentId: DocumentId): boolean => {
    if (denylist && !denylist.isReady) return false;
    if (denylist?.has(documentId)) return false;
    if (allowlist.has(documentId)) return true;
    // Already decided-no, or a decision is already in flight: deny without
    // re-prompting / re-resolving (this gate is called repeatedly per re-eval).
    if (denied.has(documentId)) return false;
    if (pending.has(documentId)) return false;

    // Undecided: kick off out-of-band resolution and deny for now.
    pending.add(documentId);
    void resolveAccess(documentId);
    return false;
  };

  // Per-channel gate. The iframe channel is fully open (all docs sync both
  // ways); the host channel enforces denylist-then-allowlist. Both `access`
  // (bidirectional gate) and `announce` (proactive push) use the same rule.
  const shareGate = async (
    peerId: PeerId,
    documentId?: DocumentId
  ): Promise<boolean> => {
    if (!documentId) return peerId !== hostRepoPeerId;
    if (peerId !== hostRepoPeerId) return true; // iframe channel: open
    return hostChannelAllows(documentId); // host channel: denylist then allowlist
  };

  const repo = new Repo({
    peerId: `intermediary-${crypto.randomUUID().slice(0, 8)}` as PeerId,
    network: [hostAdapter, iframeAdapter],
    isEphemeral: true,
    shareConfig: {
      announce: shareGate,
      access: shareGate,
    },
  });

  // Connect the host repo to the other end of the isolation host channel
  const isolationHostAdapter = new MessageChannelNetworkAdapter(
    hostChannel.port2,
    {
      useWeakRef: true,
    }
  );
  hostRepo.networkSubsystem.addNetworkAdapter(isolationHostAdapter);

  // ── Out-of-band access resolution ────────────────────────────
  // The gate (hostChannelAllows) denies any undecided document immediately and
  // enqueues it here. `pending` dedupes in-flight resolutions (the gate is
  // called repeatedly as the sync layer re-evaluates); `denied` remembers a
  // user's "no" so we never re-prompt for the same document.
  const pending = new Set<DocumentId>();
  const denied = new Set<DocumentId>();

  // Whether every change in a *resident* document was authored by the iframe.
  // Reads the already-ready handle directly — it must never trigger a fetch (a
  // fetch would re-enter the host-channel gate and deadlock), so the caller is
  // responsible for only passing a handle that is already `ready`. The
  // length > 0 guard is conservative on purpose: an empty doc doesn't
  // auto-allow, it falls through to the prompt.
  const isAuthoredSolelyByIframe = (handle: DocHandle<unknown>): boolean => {
    try {
      const doc = handle.doc();
      if (!doc) return false;
      const metas = getChangesMetaSince(doc, []);
      return (
        metas.length > 0 && metas.every((m) => m.author === iframeAuthorId)
      );
    } catch (err) {
      log(`author check for ${handle.documentId} threw`, err);
      return false;
    }
  };

  // Decide an undecided document without blocking the gate, then re-run the gate
  // via shareConfigChanged().
  const resolveAccess = async (documentId: DocumentId): Promise<void> => {
    const finish = (allow: boolean, reason: string) => {
      if (allow) {
        allowlist.addDocumentId(documentId);
        log(`access ${documentId} allowed (${reason})`);
      } else {
        denied.add(documentId);
        log(`access ${documentId} denied (${reason})`);
      }
      pending.delete(documentId);
      // Re-run the (now-decided) gate for every doc and re-engage the iframe
      // peer, which was marked hasRequested when the first denial sent it
      // doc-unavailable.
      repo.shareConfigChanged();
    };

    // Prompt for a foreign document, then finish.
    const prompt = async () => {
      if (!onAccessRequest) {
        finish(false, "no onAccessRequest handler");
        return;
      }
      log(`access ${documentId} not allowlisted; prompting user`);
      let approved = false;
      try {
        approved = await onAccessRequest(documentId);
      } catch (err) {
        log(`onAccessRequest for ${documentId} threw`, err);
      }
      finish(approved, approved ? "user approved" : "user denied");
    };

    // Classification is deterministic and event-driven (no timeout): because the
    // gate currently denies the host peer for this document, the host source
    // cannot supply it during this window. So we watch the intermediary's own
    // query for this document until it settles —
    //  - `ready` ⇒ the content came from the IFRAME (the open channel) ⇒ the
    //    iframe created it ⇒ auto-allowlist iff every change is iframe-authored
    //    (else it is resident but foreign-authored → fall through to the prompt);
    //  - `unavailable` ⇒ neither the iframe nor the (gated) host has it ⇒ it is a
    //    FOREIGN document the iframe is requesting ⇒ prompt the user.
    const state = await firstTerminalState(repo.findWithProgress(documentId));
    if (state.state === "ready") {
      if (isAuthoredSolelyByIframe(state.handle)) {
        finish(true, "authored by iframe");
      } else {
        await prompt();
      }
    } else if (state.state === "unavailable") {
      await prompt();
    } else if (state.state === "failed") {
      finish(false, `query failed: ${state.error}`);
    }
    // `loading` is unreachable — firstTerminalState only resolves on a terminal
    // state — so there is no final branch.
  };

  return {
    iframePort: iframeChannel.port2,

    shutdown() {
      isolationHostAdapter.disconnect();
      hostChannel.port1.close();
      hostChannel.port2.close();
      iframeChannel.port1.close();
      iframeChannel.port2.close();
    },
  };
}
