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

/**
 * How long the access classifier waits for the iframe to supply a document's
 * content before concluding it is foreign and prompting the user. Only a ceiling
 * for the *negative* (foreign) case — an iframe-created doc reaches `ready` as
 * soon as its already-queued sync message applies, resolving well before this.
 * Erring generous only costs a slightly later prompt for a genuinely-foreign doc
 * (which then waits on `window.confirm` anyway); the trade is a rare spurious
 * prompt for an iframe-created doc whose content lands after the grace.
 */
const IFRAME_SUPPLY_GRACE_MS = 500;

/**
 * Resolve with the ready `DocHandle` if the query reaches `ready` within
 * `graceMs`, else `null`.
 *
 * Used to classify an undecided host-channel document while the host peer is
 * held `loading` (see `hostChannelAllows`). With the host gated, the only source
 * that can bring the intermediary's query to `ready` is the IFRAME supplying the
 * content over the open channel — i.e. a document the iframe created. A foreign
 * document the iframe merely *requested* has no supplier, so its query stays
 * `pending` and this resolves `null` at the grace ceiling. The `ready` signal
 * itself is deterministic and usually near-instant; the timer only bounds the
 * no-signal (foreign) case. Returning the handle (rather than a boolean) hands
 * the author check the exact doc it observed ready. The `settled` guard makes it
 * act exactly once.
 */
function waitForIframeSupplied(
  progress: ReturnType<Repo["findWithProgress"]>,
  graceMs: number
): Promise<DocHandle<unknown> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (handle: DocHandle<unknown> | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe?.();
      resolve(handle);
    };
    const initial = progress.peek();
    if (initial.state === "ready") return finish(initial.handle);
    timer = setTimeout(() => finish(null), graceMs);
    unsubscribe = progress.subscribe((s) => {
      if (s.state === "ready") finish(s.handle);
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
 * A document the iframe references that isn't yet allowlisted is left UNDECIDED
 * by the gate, which returns a pending promise (see `hostChannelAllows`) rather
 * than an immediate deny — this holds the host peer at sharePolicyState
 * "loading" so the intermediary's query stays `pending` and the iframe's
 * one-shot `find()` never rejects. Meanwhile it is classified out of band (see
 * `resolveAccess` below): if the iframe created it (resident and authored solely
 * by the iframe) it is auto-allowlisted; otherwise the user is prompted. Once
 * decided, the pending promise is resolved and the gate re-run via
 * `repo.shareConfigChanged()`, which now answers synchronously from the
 * allowlist/denied sets. The gate itself never blocks on a fetch or a prompt —
 * doing so would stall the sync (see `hostChannelAllows`).
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
  // MUST be allowlisted. Terminal answers (denylisted / allowlisted / user-
  // denied) return synchronously. An *undecided* document returns a PENDING
  // promise that resolves once `resolveAccess` decides it.
  //
  // Why pending rather than an immediate deny: automerge-repo holds a peer at
  // sharePolicyState "loading" while its `access` promise is unresolved, and a
  // query with any "loading" peer stays `pending` (never `unavailable`). If we
  // denied the host peer up front instead, the intermediary's query would settle
  // `unavailable` and emit `doc-unavailable` to the iframe — which makes the
  // iframe's one-shot `find()` reject, so the tool gives up and never recovers
  // even after the user approves (it would need a full re-render). Holding the
  // host peer "loading" keeps the iframe's `find()` pending until we decide, so
  // an approval resolves it to `ready` with no re-render. See `resolveAccess`.
  //
  // While the denylist is still populating we fail closed (allow nothing to/from
  // the host) — the boot path awaits denylist readiness before this repo exists,
  // so this is defense in depth. This is the single security boundary; the
  // iframe channel is open.
  const hostChannelAllows = (
    documentId: DocumentId
  ): boolean | Promise<boolean> => {
    if (denylist && !denylist.isReady) return false;
    if (denylist?.has(documentId)) return false;
    if (allowlist.has(documentId)) return true; // approved / auto-allowed
    if (denied.has(documentId)) return false; // user said no

    // Undecided: return the SAME pending decision promise on every re-eval
    // (dedup), and kick off out-of-band resolution exactly once.
    const decision = decisionFor(documentId);
    if (!pending.has(documentId)) {
      pending.add(documentId);
      void resolveAccess(documentId);
    }
    return decision.promise;
  };

  // Per-channel gate. The iframe channel is fully open (all docs sync both
  // ways); the host channel enforces denylist-then-allowlist. Both `access`
  // (bidirectional gate) and `announce` (proactive push) use the same rule — so
  // once a pending decision resolves true, the host peer becomes "announce" and
  // the intermediary actively serves the doc in both directions.
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
  // The gate (hostChannelAllows) returns a pending decision promise for any
  // undecided document and enqueues it here.
  //  - `pending` dedupes: it guards that we spawn exactly one `resolveAccess`
  //    (and thus at most one prompt) per document, even though the gate is
  //    re-evaluated repeatedly.
  //  - `denied` remembers a user's "no" so the gate answers a synchronous false
  //    without re-prompting.
  //  - `decisions` holds the single shared pending promise per document, so
  //    every re-evaluation during the window returns the *same* promise (which
  //    is what pins the host peer at "loading" — see hostChannelAllows).
  const pending = new Set<DocumentId>();
  const denied = new Set<DocumentId>();

  type Decision = {
    promise: Promise<boolean>;
    resolve: (allow: boolean) => void;
    settled: boolean;
  };
  const decisions = new Map<DocumentId, Decision>();

  const decisionFor = (documentId: DocumentId): Decision => {
    let d = decisions.get(documentId);
    if (!d) {
      let resolve!: (allow: boolean) => void;
      const promise = new Promise<boolean>((res) => {
        resolve = res;
      });
      d = { promise, resolve, settled: false };
      decisions.set(documentId, d);
    }
    return d;
  };

  const settleDecision = (documentId: DocumentId, allow: boolean): void => {
    // Normally a get — the gate created this decision before spawning
    // resolveAccess. The create-if-missing keeps settle safe if a future path
    // ever settles a doc before any gate evaluation.
    const d = decisionFor(documentId);
    if (d.settled) return;
    d.settled = true;
    d.resolve(allow);
  };

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

  // Decide an undecided document out of band (never blocking the gate), resolve
  // its pending decision promise, then re-run the gate via shareConfigChanged().
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
      // Resolve the pending host-gate promise FIRST (see `hostChannelAllows`),
      // then re-run the gate for every doc. The fresh evaluation triggered by
      // shareConfigChanged now sees the doc in allowlist/denied and answers a
      // synchronous boolean — flipping the host peer to "announce" (so the
      // intermediary fetches the doc from the host and pushes it to the
      // still-waiting iframe) or to "denied" (query settles unavailable → the
      // iframe is told, as it should be on an explicit denial).
      settleDecision(documentId, allow);
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

    // Classify iframe-created vs foreign. The host peer is held "loading" by the
    // pending gate, so the intermediary's query for this doc can only reach
    // `ready` if the IFRAME supplied the content over the open channel — i.e. the
    // iframe created it. If the iframe doesn't supply it within the grace window,
    // it is a FOREIGN document the iframe is merely requesting → prompt.
    const progress = repo.findWithProgress(documentId);
    const handle = await waitForIframeSupplied(progress, IFRAME_SUPPLY_GRACE_MS);
    if (handle && isAuthoredSolelyByIframe(handle)) {
      finish(true, "authored by iframe");
    } else {
      // Not iframe-supplied, or resident but not solely iframe-authored → prompt.
      await prompt();
    }
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
