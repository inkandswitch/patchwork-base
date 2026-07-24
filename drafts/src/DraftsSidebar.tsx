import "./styles.css";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import { createDocSignal } from "solid-automerge";
import type {
  AutomergeUrl,
  DocHandle,
  Repo,
  UrlHeads,
} from "@automerge/automerge-repo";
import { decodeHeads, encodeHeads } from "@automerge/automerge-repo";
import * as Automerge from "@automerge/automerge";
import { getRegistry, isLoadedPlugin } from "@inkandswitch/patchwork-plugins";
import {
  subscribe,
  subscribeDoc,
} from "@inkandswitch/patchwork-providers-solid";
import type {
  CachedGroup,
  ChangeGroupCacheDoc,
  CheckedOutDraft,
  CloneEntry,
  DraftCheckpoint,
  DraftDoc,
  DraftList,
  DraftMemberDoc,
  HasDrafts,
} from "./draft-types";
import {
  computeEditCounts,
  ensureMainDraft,
  getDocCreationTime,
} from "./change-group-cache";

// Seed for the read-only `draft:list` subscription until the provider answers.
// `main.url` is a placeholder; the Main card displays the host doc url instead.
const EMPTY_DRAFT_LIST: DraftList = {
  main: {
    url: "" as AutomergeUrl,
    members: [],
    childCount: 0,
    name: null,
    changeGroupCacheUrl: null,
  },
  drafts: [],
};

// Bump on each deploy to eyeball whether the latest build has synced.
const DRAFTS_VERSION = "0.0.28";

// Logged at module load so the console shows which build is running even
// before the panel renders.
console.log(`[drafts] DraftsSidebar v${DRAFTS_VERSION} loaded`);

export function DraftsSidebar(props: { element: HTMLElement }) {
  const [hostDoc, hostDocHandle] = subscribeDoc<HasDrafts>(props.element, {
    type: "draft:root-doc",
  });

  // Selection only: which draft is checked out (writeable).
  const [, checkedOutHandle] = subscribeDoc<CheckedOutDraft>(props.element, {
    type: "draft:checked-out",
  });

  // Read the checkout doc coarsely from the live handle (handle.doc()) rather
  // than a fine-grained patch-replay projection: the projection can render a
  // whole-value write doubled, whereas handle.doc() is always the correct
  // materialized document.
  const checkedOut = createDocSignal(checkedOutHandle);
  const selected = createMemo<AutomergeUrl | null>(
    () => checkedOut()?.checkedOut ?? null
  );

  // The eye toggle's state, derived from the checkpoint itself (no separate
  // flag): the eye is open — diffs showing — iff the current checkpoint
  // carries any diff baseline (`from`).
  const eyeOpen = createMemo<boolean>(() => {
    const at = checkedOut()?.at;
    return !!at && Object.values(at).some((e) => e.from !== undefined);
  });

  // Whether the view is actually pinned to history (any member has a `to`),
  // as opposed to live-with-baseline (eye open, nothing pinned).
  const isPinned = createMemo<boolean>(() => {
    const at = checkedOut()?.at;
    return !!at && Object.values(at).some((e) => e.to !== undefined);
  });

  // Where the scrubber sits: the change whose heads are displayed. Ephemeral,
  // client-only state: the stored checkpoint (`checkedOut.at`) is what
  // actually pins the view; this mirrors it to render the token and the
  // group highlight. Not persisted, so it resets on reload (the pinned view
  // survives).
  const [scrubber, setScrubber] = createSignal<ScrubberState | null>(null);

  // Where the diff baseline handle sits: an absolute point in history the
  // diff is measured from, independent of the head (`scrubber`). Ephemeral
  // like the head — resets on reload, while the persisted `from` keeps
  // driving the editor diff. Non-null only while the eye is open and a
  // version is pinned; that is also exactly when the handle renders.
  const [baseliner, setBaseliner] = createSignal<BaselineState | null>(null);

  // A version being dragged out of a history timeline (from a group row or
  // the scrubber sticker). While set, the actions area shows a drop zone
  // that forks a new draft at that version; cleared on drop or dragend.
  const [dragVersion, setDragVersion] = createSignal<{
    members: DraftMemberDoc[];
    head: ChangeRef;
  } | null>(null);
  const [dropActive, setDropActive] = createSignal(false);

  // The derived drafts list (read-only): main plus each draft with its member
  // docs, recomputed and pushed by the provider.
  const list = subscribe<DraftList>(
    props.element,
    { type: "draft:list" },
    EMPTY_DRAFT_LIST
  );

  const isMainSelected = createMemo(() => selected() === null);
  // Drafting off a folder isn't supported yet, so creating a draft is disabled
  // while viewing a folder on Main.
  const isFolder = createMemo(
    () => hostDoc()?.["@patchwork"]?.type === "folder"
  );

  const selectDraft = (url: AutomergeUrl | null) => {
    const handle = checkedOutHandle();
    if (!handle) return;
    setScrubber(null);
    setBaseliner(null);
    handle.change((d) => {
      d.checkedOut = url;
      // Switching drafts (or to main) returns to the live latest heads.
      d.at = null;
    });
  };

  const getRepo = (): Repo | undefined =>
    "repo" in window ? window.repo : undefined;

  // Monotonic counter so a slow checkpoint computation can't overwrite a newer
  // scrub position (a drag fires one recompute per snapped change).
  let scrubSeq = 0;

  // Recompute and persist the checkpoint from the current head (`scrubber`)
  // and baseline (`baseliner`) signals: `to`s follow the head, `from`s follow
  // the baseline (absolute, independent of the head). With the eye closed the
  // baseline is null and no `from` is written. The token and row highlight
  // update immediately from the signals; the checkpoint follows async.
  // `draftUrl` is `null` for main. Guarded by `scrubSeq` so a slower
  // computation can't clobber a newer drag.
  const applyPins = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[]
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    const head = scrubber();
    if (!head) return;
    const bl = baseliner();
    const base: CheckpointBase = bl ? { beforeTime: bl.time } : "none";
    const seq = ++scrubSeq;
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, head.head, base);
      // A newer scrub landed while this one was computing; drop it.
      if (seq !== scrubSeq) return;
      handle.change((d) => {
        d.checkedOut = draftUrl;
        d.at = checkpoint;
      });
    })();
  };

  // Move the head (the version being viewed); the baseline stays where it is.
  const onScrub = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    scrub: ScrubberState
  ) => {
    setScrubber(scrub);
    applyPins(draftUrl, members);
  };

  // Move the diff baseline; the head stays where it is. Only reachable while
  // the eye is open and pinned (that is when the handle renders).
  const onBaselineScrub = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    base: BaselineState
  ) => {
    setBaseliner(base);
    applyPins(draftUrl, members);
  };

  // The member docs of the current selection (`null` = main), for the eye
  // and checkpoint handlers below.
  const membersFor = (draftUrl: AutomergeUrl | null): DraftMemberDoc[] =>
    draftUrl
      ? (list().drafts.find((s) => s.url === draftUrl)?.members ?? [])
      : list().main.members;

  // The eye-open checkpoint for a live (unpinned) draft: every cloned member
  // diffs against its fork point, nothing pinned.
  const forkBaselines = (draftUrl: AutomergeUrl): DraftCheckpoint => {
    const at: DraftCheckpoint = {};
    for (const member of membersFor(draftUrl)) {
      if (member.clonedAt) at[member.url] = { from: member.clonedAt };
    }
    return at;
  };

  // Drop the time pin but stay on the same draft: back to live latest heads.
  // With the eye open on a draft the diff baselines survive — the view goes
  // live but keeps showing what changed since the fork point. (A live main
  // has nothing to diff against, so there the eye closes with the pin.)
  const clearCheckpoint = () => {
    const handle = checkedOutHandle();
    if (!handle) return;
    setScrubber(null);
    // Unpinned: the baseline handle only shows while pinned, so drop it.
    setBaseliner(null);
    const draftUrl = selected();
    const baselines = eyeOpen() && draftUrl ? forkBaselines(draftUrl) : null;
    handle.change((d) => {
      d.at =
        baselines && Object.keys(baselines).length > 0 ? baselines : null;
    });
  };

  // The eye toggle: show or hide diff highlighting. The eye holds no state of
  // its own — it rewrites the checkpoint's per-member `from`s (which the
  // provider serves as `draft:baseline`), and its open/closed state is read
  // back off the checkpoint (`eyeOpen`).
  const toggleEye = () => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;

    if (eyeOpen()) {
      // Close: strip the baselines; a pin (`to`) stays untouched. Baseline-
      // only entries disappear entirely, so a live view's `at` goes to null.
      setBaseliner(null);
      handle.change((d) => {
        if (!d.at) return;
        const urls = Object.keys(d.at) as AutomergeUrl[];
        if (!urls.some((u) => d.at?.[u]?.to !== undefined)) {
          d.at = null;
          return;
        }
        for (const url of urls) {
          const entry = d.at[url];
          if (!entry) continue;
          if (entry.to === undefined) delete d.at[url];
          else delete entry.from;
        }
      });
      return;
    }

    const draftUrl = selected();
    const s = scrubber();
    if (isPinned() && s) {
      // Pinned with a known scrub position: seed the baseline handle at the
      // scrubbed group's start and recompute the checkpoint against it. The
      // handle's exact offset is resolved by the changes list, which knows
      // the group's size (BASELINE_GROUP_START).
      setBaseliner({
        groupId: s.groupId,
        offset: BASELINE_GROUP_START,
        time: s.groupStartTime,
      });
      const members = membersFor(draftUrl);
      const seq = ++scrubSeq;
      void (async () => {
        const checkpoint = await computeCheckpoint(repo, members, s.head, {
          beforeTime: s.groupStartTime,
        });
        if (seq !== scrubSeq) return;
        handle.change((d) => {
          d.at = checkpoint;
        });
      })();
      return;
    }

    if (isPinned()) {
      // Pinned but the scrub position is unknown (the sidebar remounted
      // while the pin survived): fall back to diffing the pinned view
      // against the fork point.
      const clonedAt = new Map(
        membersFor(draftUrl).map((m) => [m.url, m.clonedAt])
      );
      handle.change((d) => {
        if (!d.at) return;
        for (const url of Object.keys(d.at) as AutomergeUrl[]) {
          const entry = d.at[url];
          if (!entry) continue;
          entry.from = clonedAt.get(url) ?? encodeHeads([]);
        }
      });
      return;
    }

    // Live on a draft: show what changed since the fork point. (Live on
    // main the button is disabled — there is no baseline to diff against.)
    if (!draftUrl) return;
    const baselines = forkBaselines(draftUrl);
    if (Object.keys(baselines).length === 0) return;
    handle.change((d) => {
      d.at = baselines;
    });
  };

  // While the eye is open on a live (unpinned) draft, keep the baseline map
  // in step with the member list: a doc forked after the eye was opened gets
  // its fork-point baseline added here. (The provider serves baselines only
  // from the checkpoint — there is no implicit fallback to cover it.)
  createEffect(() => {
    const at = checkedOut()?.at;
    const draftUrl = selected();
    const handle = checkedOutHandle();
    if (!at || !draftUrl || !handle) return;
    const entries = Object.values(at);
    if (entries.length === 0) return;
    if (entries.some((e) => e.to !== undefined)) return; // pinned: onScrub owns it
    if (!entries.some((e) => e.from !== undefined)) return; // eye closed
    const missing = membersFor(draftUrl).filter(
      (m) => m.clonedAt !== null && !at[m.url]
    );
    if (missing.length === 0) return;
    handle.change((d) => {
      if (!d.at) return;
      for (const m of missing) {
        if (m.clonedAt) d.at[m.url] = { from: m.clonedAt };
      }
    });
  });

  const onCreateDraft = async () => {
    if (isFolder()) return;
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }

    // Top-level drafts branch off the main draft and live in its `drafts`
    // list. The main draft is created lazily the first time we draft this doc.
    const mainDraft = await ensureMainDraft(repo, docHandle);
    const draft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parent: mainDraft.url,
      drafts: [],
      clones: {},
    });
    mainDraft.change((d) => {
      d.drafts.push(draft.url);
    });
    selectDraft(draft.url);
  };

  // Fork a new top-level draft off a historical version: every member doc is
  // cloned at the heads it had as of `head` (the dragged-out change), not at
  // the live latest. Pre-populating `DraftDoc.clones` here means the overlay's
  // lazy `resolveClone` reuses these entries instead of forking at current
  // heads. Members with no changes at or before the version (created later)
  // are left out; the version's docs don't reference them yet, so they are
  // normally never resolved beneath the draft.
  const onCreateDraftFromVersion = async (
    members: DraftMemberDoc[],
    head: ChangeRef
  ) => {
    if (isFolder()) return;
    const docHandle = hostDocHandle();
    if (!docHandle) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }

    // Reuse the scrub machinery to resolve per-doc heads at this version
    // (only the `to`s are read, so no diff baseline).
    const checkpoint = await computeCheckpoint(repo, members, head, "none");

    const clones: Record<AutomergeUrl, CloneEntry> = {};
    for (const member of members) {
      const to = checkpoint[member.url]?.to;
      if (!to) continue;
      let handle: DocHandle<unknown> | null = null;
      try {
        // Clone the doc the timeline read its changes from (the draft's clone
        // when dragging out of a draft), pinned to the version's heads.
        // Keyed by the original url so baselines and merge-back resolve.
        handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
        const clone = cloneAtVersion(repo, handle, to);
        clones[member.url] = { cloneUrl: clone.url, clonedAt: to };
      } catch (err) {
        reportForkFailure(
          handle ? collectForkDiagnostic(handle, member, to) : null,
          err
        );
      }
    }

    const mainDraft = await ensureMainDraft(repo, docHandle);
    const draft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      parent: mainDraft.url,
      drafts: [],
      clones,
    });
    mainDraft.change((d) => {
      d.drafts.push(draft.url);
    });
    selectDraft(draft.url);
  };

  // Rename a draft, or main (`url === null`). Names live on the `DraftDoc`;
  // renaming main creates the main draft doc if this is the first draft-ish
  // action on the host doc. `null` clears back to the default label.
  const onRename = async (url: AutomergeUrl | null, name: string | null) => {
    const repo = getRepo();
    if (!repo) return;
    let handle: DocHandle<DraftDoc>;
    if (url === null) {
      const docHandle = hostDocHandle();
      if (!docHandle) return;
      handle = await ensureMainDraft(repo, docHandle);
    } else {
      handle = await repo.find<DraftDoc>(url);
    }
    handle.change((d) => {
      if (name) d.name = name;
      else delete d.name;
    });
  };

  const onMergeDraft = async () => {
    const draftUrl = selected();
    if (!draftUrl) return;
    if (!window.confirm("Merge this draft into the main document?")) return;
    const repo = getRepo();
    if (!repo) {
      console.warn("[drafts] window.repo is not set");
      return;
    }
    const draftHandle = await repo.find<DraftDoc>(draftUrl);
    await mergeDraft(repo, draftHandle);
    selectDraft(null);
  };

  return (
    <div class="drafts-panel">
      <Show
        when={hostDoc()}
        fallback={<div class="drafts-empty">No document selected.</div>}
      >
        <Show when={isMainSelected()}>
          <div class="drafts-actions drafts-actions--top">
            <button
              class="drafts-btn drafts-btn--primary"
              disabled={isFolder()}
              onClick={onCreateDraft}
              title={
                isFolder()
                  ? "Drafts aren't supported for folders yet"
                  : "Create a new draft off this document"
              }
            >
              New draft
            </button>
            <Show when={isFolder()}>
              <span class="drafts-hint">
                Drafts aren't supported for folders yet.
              </span>
            </Show>
          </div>
        </Show>
        <div class="drafts-list">
          <MainCard
            hostDocUrl={hostDocHandle()?.url}
            isSelected={isMainSelected()}
            members={() => list().main.members}
            changeGroupCacheUrl={list().main.changeGroupCacheUrl}
            name={list().main.name}
            onRename={(name) => void onRename(null, name)}
            onSelect={() => selectDraft(null)}
            onScrub={(scrub) => onScrub(null, list().main.members, scrub)}
            scrubber={() => (isMainSelected() ? scrubber() : null)}
            onBaselineScrub={(base) =>
              onBaselineScrub(null, list().main.members, base)
            }
            baseliner={() => (isMainSelected() ? baseliner() : null)}
            onDragVersion={(head) =>
              setDragVersion(
                head ? { members: list().main.members, head } : null
              )
            }
            hasCheckpoint={isMainSelected() && isPinned()}
            onReturnToLatest={clearCheckpoint}
            eyeOpen={isMainSelected() && eyeOpen()}
            eyeDisabled={!isPinned()}
            onToggleEye={toggleEye}
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                members={summary.members}
                changeGroupCacheUrl={summary.changeGroupCacheUrl}
                mainDocUrl={hostDocHandle()?.url}
                isSelected={selected() === summary.url}
                name={summary.name}
                onRename={(name) => void onRename(summary.url, name)}
                onSelect={selectDraft}
                onScrub={(scrub) =>
                  onScrub(summary.url, summary.members, scrub)
                }
                scrubber={() =>
                  selected() === summary.url ? scrubber() : null
                }
                onBaselineScrub={(base) =>
                  onBaselineScrub(summary.url, summary.members, base)
                }
                baseliner={() =>
                  selected() === summary.url ? baseliner() : null
                }
                onDragVersion={(head) =>
                  setDragVersion(
                    head ? { members: summary.members, head } : null
                  )
                }
                hasCheckpoint={selected() === summary.url && isPinned()}
                onReturnToLatest={clearCheckpoint}
                eyeOpen={selected() === summary.url && eyeOpen()}
                eyeDisabled={false}
                onToggleEye={toggleEye}
              />
            )}
          </For>
        </div>
        <div class="drafts-actions">
          <Show when={dragVersion()}>
            <div
              class="drafts-dropzone"
              data-over={dropActive() ? "" : undefined}
              onDragEnter={(e) => {
                e.preventDefault();
                setDropActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={() => setDropActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                const version = dragVersion();
                setDropActive(false);
                setDragVersion(null);
                if (version) {
                  void onCreateDraftFromVersion(version.members, version.head);
                }
              }}
            >
              Drop to fork a new draft from this version
            </div>
          </Show>
          <Show when={!isMainSelected()}>
            <button
              class="drafts-btn drafts-btn--warning"
              onClick={onMergeDraft}
              title="Merge this draft into Main"
            >
              Merge into Main
            </button>
          </Show>
        </div>
      </Show>
      <div class="drafts-version">v{DRAFTS_VERSION}</div>
    </div>
  );
}

// Merges every cloned doc back into its original, recording per-clone
// merge heads for auditing, and marks the draft as merged.
async function mergeDraft(
  repo: Repo,
  draftHandle: DocHandle<DraftDoc>
): Promise<void> {
  const entries = Object.entries(draftHandle.doc()?.clones ?? {}) as [
    AutomergeUrl,
    CloneEntry,
  ][];
  for (const [originalUrl, entry] of entries) {
    if (entry.cloneUrl === originalUrl) continue;
    const [original, clone] = await Promise.all([
      repo.find<unknown>(originalUrl),
      repo.find<unknown>(entry.cloneUrl),
    ]);
    original.merge(clone);
    const mergedAt = original.heads();
    draftHandle.change((d) => {
      const e = d.clones[originalUrl];
      if (e) e.mergedAt = mergedAt;
    });
  }
  draftHandle.change((d) => {
    d.mergedAt = Date.now();
  });
}

// --- Cloning a member at a version -------------------------------------------
// The obvious way — `repo.clone(handle.view(to))`, i.e. wasm `fork_at` — is
// broken upstream: on documents whose history contains certain concurrent
// merge changes (as anything synced through subduction ends up with),
// `fork_at` panics with `MissingOps` in `ChangeCollector::from_build_meta`
// at *any* heads, and the panic poisons the doc object for the rest of the
// session (every later call throws "recursive use of an object detected").
// Confirmed offline against automerge 3.3.0-fragments.1 and .2 with a
// 26-change minimal repro.
//
// So the version clone is built without `fork_at`: collect the ancestor
// closure of the pin heads from the change metadata, bundle exactly those
// changes (`saveBundle`), hydrate a fresh doc from the bundle
// (`loadIncremental`), and install it into a new repo handle — the same move
// `repo.clone` performs internally, minus the panicking wasm path. The
// resulting doc's heads are exactly `to`, it shares history with the
// original, and merges back cleanly.

// Build a clone of `handle`'s doc pinned to the `to` heads and register it
// with the repo. Throws (a plain JS error, no wasm panic) when the pin's
// ancestry can't be resolved from the doc's change metadata.
function cloneAtVersion(
  repo: Repo,
  handle: DocHandle<unknown>,
  to: UrlHeads
): DocHandle<unknown> {
  const doc = handle.doc() as Automerge.Doc<unknown>;
  const pinHeads = decodeHeads(to);

  // Ancestor closure of the pin heads, walked over the full change metadata.
  const metas = Automerge.getChangesMetaSince(doc, []);
  const byHash = new Map(metas.map((m) => [m.hash, m]));
  const closure = new Set<string>();
  const stack = [...pinHeads];
  while (stack.length > 0) {
    const hash = stack.pop()!;
    if (closure.has(hash)) continue;
    const meta = byHash.get(hash);
    if (!meta) {
      throw new Error(
        `[drafts] change ${hash} is not in the doc's history metadata`
      );
    }
    closure.add(hash);
    stack.push(...meta.deps);
  }

  const bundle = Automerge.saveBundle(doc, [...closure]);
  const pinned = Automerge.loadIncremental(Automerge.init<unknown>(), bundle);

  const gotHeads = [...Automerge.getHeads(pinned)].sort();
  const wantHeads = [...pinHeads].sort();
  if (JSON.stringify(gotHeads) !== JSON.stringify(wantHeads)) {
    throw new Error(
      `[drafts] version clone heads mismatch: wanted ${wantHeads}, got ${gotHeads}`
    );
  }

  const clone = repo.create<unknown>();
  clone.update(() => pinned);
  return clone;
}

// --- Fork-at-version diagnostics --------------------------------------------
// When `cloneAtVersion` fails, everything we can learn about the member and
// the pinned heads is dumped as one JSON block tagged
// [drafts][fork-diagnostic]; paste that back when reporting.

// Everything we could learn about the member and the pinned heads, plus the
// final error.
type ForkDiagnostic = {
  draftsVersion: string;
  memberUrl: AutomergeUrl;
  sourceUrl: AutomergeUrl;
  memberClonedAt: UrlHeads | null;
  // The version being forked at, as url-encoded heads and as hex hashes.
  to: UrlHeads;
  toHex: string[];
  // The doc's live frontier (hex), for comparison with `toHex`.
  currentHeads: string[] | null;
  // Does the doc itself consider `toHex` a valid point in its history?
  hasHeads: boolean | null;
  // Change hashes the doc knows it is missing ops for, as of `toHex`.
  missingDeps: string[] | null;
  stats: { numChanges: number; numOps: number } | null;
  automerge: {
    jsGitHead: string;
    wasmGitHead: string | null;
    wasmVersion: string | null;
  } | null;
  // Where each pinned hash sits in the doc's history: its topological index,
  // metadata, and whether it is a live head. `known: false` means the doc has
  // no change with that hash at all.
  pinnedChanges: {
    hash: string;
    known: boolean;
    topoIndex: number | null;
    time: number | null;
    actor: string | null;
    seq: number | null;
    deps: string[] | null;
    isCurrentHead: boolean;
  }[];
  // Sedimentree fragment coverage: how the doc's history is bundled.
  // `topoRange` is the [min, max] topological index of the fragment's member
  // changes and `containsPin` whether a pinned hash is one of them — so a
  // fork-depth failure boundary can be read directly against bundle
  // boundaries. A pinned hash buried inside a higher-level bundle is the
  // prime MissingOps suspect.
  fragments:
    | {
        level: number;
        head: string;
        memberCount: number;
        topoRange: [number, number] | null;
        containsPin: boolean;
      }[]
    | null;
  probeErrors: string[];
  failure?: { message: string; stack?: string };
};

// The saved doc bytes captured before the failing fork, kept out of the JSON
// report (too big) and exposed on `window.__draftsForkRepro` instead, so the
// exact failing document can be reproduced offline.
type ForkRepro = {
  url: AutomergeUrl;
  toHex: string[];
  docBase64: string;
};

// Snapshot everything we can read about `handle`'s doc and the pinned heads.
// Every probe is individually guarded so one bad call doesn't lose the rest.
function collectForkDiagnostic(
  handle: DocHandle<unknown>,
  member: DraftMemberDoc,
  to: UrlHeads
): ForkDiagnostic {
  const diagnostic: ForkDiagnostic = {
    draftsVersion: DRAFTS_VERSION,
    memberUrl: member.url,
    sourceUrl: member.cloneUrl ?? member.url,
    memberClonedAt: member.clonedAt,
    to,
    toHex: [],
    currentHeads: null,
    hasHeads: null,
    missingDeps: null,
    stats: null,
    automerge: null,
    pinnedChanges: [],
    fragments: null,
    probeErrors: [],
  };
  const probe = (name: string, run: () => void) => {
    try {
      run();
    } catch (err) {
      diagnostic.probeErrors.push(`${name}: ${String(err)}`);
    }
  };

  probe("decodeHeads", () => {
    diagnostic.toHex = decodeHeads(to);
  });

  const doc = handle.doc() as Automerge.Doc<unknown>;

  probe("getHeads", () => {
    diagnostic.currentHeads = Automerge.getHeads(doc);
  });
  probe("hasHeads", () => {
    diagnostic.hasHeads = Automerge.hasHeads(doc, diagnostic.toHex);
  });
  probe("getMissingDeps", () => {
    diagnostic.missingDeps = Automerge.getMissingDeps(doc, diagnostic.toHex);
  });
  probe("stats", () => {
    const s = Automerge.stats(doc);
    diagnostic.stats = { numChanges: s.numChanges, numOps: s.numOps };
  });
  probe("releaseInfo", () => {
    const info = Automerge.releaseInfo();
    diagnostic.automerge = {
      jsGitHead: info.js.gitHead,
      wasmGitHead: info.wasm?.gitHead ?? null,
      wasmVersion: info.wasm?.cargoPackageVersion ?? null,
    };
  });
  probe("pinnedChanges", () => {
    const topo = Automerge.topoHistoryTraversal(doc);
    const metas = Automerge.getChangesMetaSince(doc, []);
    const metaByHash = new Map(metas.map((m) => [m.hash, m]));
    diagnostic.pinnedChanges = diagnostic.toHex.map((hash) => {
      const meta = metaByHash.get(hash);
      const topoIndex = topo.indexOf(hash);
      return {
        hash,
        known: !!meta || topoIndex >= 0,
        topoIndex: topoIndex >= 0 ? topoIndex : null,
        time: meta?.time ?? null,
        actor: meta?.actor ?? null,
        seq: meta?.seq ?? null,
        deps: meta?.deps ?? null,
        isCurrentHead: diagnostic.currentHeads?.includes(hash) ?? false,
      };
    });
  });
  probe("fragments", () => {
    const topo = Automerge.topoHistoryTraversal(doc);
    const topoIndex = new Map(topo.map((h, i) => [h, i]));
    const pinned = new Set(diagnostic.toHex);
    diagnostic.fragments = Automerge.getFragmentMetadata(doc).map((f) => {
      let min = Infinity;
      let max = -Infinity;
      let containsPin = false;
      for (const h of f.members) {
        const i = topoIndex.get(h);
        if (i !== undefined) {
          if (i < min) min = i;
          if (i > max) max = i;
        }
        if (pinned.has(h)) containsPin = true;
      }
      return {
        level: f.level,
        head: f.head,
        memberCount: f.members.length,
        topoRange: min <= max ? ([min, max] as [number, number]) : null,
        containsPin,
      };
    });
  });
  probe("saveDoc", () => {
    // Capture the full doc bytes for an offline repro; published to
    // `window.__draftsForkRepro` by `reportForkFailure`.
    const bytes = Automerge.save(doc);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    lastForkRepro = {
      url: member.url,
      toHex: diagnostic.toHex,
      docBase64: btoa(binary),
    };
  });

  return diagnostic;
}

// The most recent member's saved bytes, captured by `collectForkDiagnostic`
// and published by `reportForkFailure` when its member's fork fails.
let lastForkRepro: ForkRepro | null = null;

// Dump the diagnostic and the error as one copy-pasteable JSON block.
function reportForkFailure(
  diagnostic: ForkDiagnostic | null,
  err: unknown
): void {
  const failure = {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
  if (!diagnostic) {
    console.error(
      "[drafts][fork-diagnostic] failed before diagnostics could be gathered:",
      failure
    );
    return;
  }
  diagnostic.failure = failure;
  if (lastForkRepro && lastForkRepro.url === diagnostic.memberUrl) {
    (window as unknown as Record<string, unknown>).__draftsForkRepro =
      lastForkRepro;
  }
  console.error(
    "[drafts][fork-diagnostic] failed to fork member at version — paste this block back:\n" +
      JSON.stringify(diagnostic, null, 2) +
      "\n[drafts][fork-diagnostic] the failing doc's bytes are on " +
      "window.__draftsForkRepro — to save them for an offline repro, run:\n" +
      "  const r = window.__draftsForkRepro;\n" +
      "  const bytes = Uint8Array.from(atob(r.docBase64), c => c.charCodeAt(0));\n" +
      "  const a = document.createElement('a');\n" +
      "  a.href = URL.createObjectURL(new Blob([bytes]));\n" +
      "  a.download = 'fork-repro.automerge'; a.click();\n" +
      "  console.log('pin heads:', r.toHex);"
  );
}

function MainCard(props: {
  hostDocUrl: AutomergeUrl | undefined;
  isSelected: boolean;
  members: Accessor<DraftMemberDoc[]>;
  changeGroupCacheUrl: AutomergeUrl | null;
  name: string | null;
  onRename: (name: string | null) => void;
  onSelect: () => void;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onBaselineScrub: (base: BaselineState) => void;
  baseliner: Accessor<BaselineState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
  hasCheckpoint: boolean;
  onReturnToLatest: () => void;
  eyeOpen: boolean;
  eyeDisabled: boolean;
  onToggleEye: () => void;
}) {
  return (
    <div class="draft-card" data-selected={props.isSelected ? "" : undefined}>
      {/* A div, not a <button>: the rename input rendered inside would be
          invalid (and misbehave) nested in a button. */}
      <div
        class="draft-card-header"
        onClick={props.onSelect}
        title="Main version (host document)"
      >
        <div class="draft-card-title">
          <DraftName
            name={props.name}
            fallback="Main"
            onRename={props.onRename}
          />
          {/* Shown left of the eye while the timeline is pinned: drops the
              pin and returns to the live latest heads. It lives inside the
              clickable header, so the click is stopped from also
              re-selecting the card. */}
          <Show when={props.hasCheckpoint}>
            <button
              type="button"
              class="draft-card-return"
              onClick={(e) => {
                e.stopPropagation();
                props.onReturnToLatest();
              }}
              title="Return to the latest version"
            >
              Return to latest
            </button>
          </Show>
          <Show when={props.isSelected}>
            <EyeToggle
              open={props.eyeOpen}
              disabled={props.eyeDisabled}
              onToggle={props.onToggleEye}
            />
          </Show>
        </div>
      </div>
      <Show when={props.isSelected}>
        <DraftChangesList
          members={props.members}
          changeGroupCacheUrl={props.changeGroupCacheUrl}
          mainDocUrl={props.hostDocUrl}
          onScrub={props.onScrub}
          scrubber={props.scrubber}
          onBaselineScrub={props.onBaselineScrub}
          baseliner={props.baseliner}
          eyeOpen={() => props.eyeOpen}
          onDragVersion={props.onDragVersion}
          onReturnToLatest={props.onReturnToLatest}
        />
      </Show>
    </div>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  members: DraftMemberDoc[];
  changeGroupCacheUrl: AutomergeUrl | null;
  mainDocUrl: AutomergeUrl | undefined;
  isSelected: boolean;
  name: string | null;
  onRename: (name: string | null) => void;
  onSelect: (url: AutomergeUrl) => void;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onBaselineScrub: (base: BaselineState) => void;
  baseliner: Accessor<BaselineState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
  hasCheckpoint: boolean;
  onReturnToLatest: () => void;
  eyeOpen: boolean;
  eyeDisabled: boolean;
  onToggleEye: () => void;
}) {
  return (
    <div class="draft-card" data-selected={props.isSelected ? "" : undefined}>
      {/* A div, not a <button>: see MainCard. */}
      <div
        class="draft-card-header"
        onClick={() => props.onSelect(props.url)}
        title="Open draft"
      >
        <div class="draft-card-title">
          <DraftName
            name={props.name}
            fallback="Draft"
            onRename={props.onRename}
          />
          {/* See MainCard: pinned-only "return to latest" control in the title. */}
          <Show when={props.hasCheckpoint}>
            <button
              type="button"
              class="draft-card-return"
              onClick={(e) => {
                e.stopPropagation();
                props.onReturnToLatest();
              }}
              title="Return to the latest version"
            >
              Return to latest
            </button>
          </Show>
          <Show when={props.isSelected}>
            <EyeToggle
              open={props.eyeOpen}
              disabled={props.eyeDisabled}
              onToggle={props.onToggleEye}
            />
          </Show>
        </div>
      </div>
      <Show when={props.isSelected}>
        <DraftChangesList
          members={() => props.members}
          changeGroupCacheUrl={props.changeGroupCacheUrl}
          mainDocUrl={props.mainDocUrl}
          onScrub={props.onScrub}
          scrubber={props.scrubber}
          onBaselineScrub={props.onBaselineScrub}
          baseliner={props.baseliner}
          eyeOpen={() => props.eyeOpen}
          onDragVersion={props.onDragVersion}
          onReturnToLatest={props.onReturnToLatest}
        />
      </Show>
    </div>
  );
}

// A card's display name. Double-click to rename inline: Enter or clicking
// away commits, Escape cancels, and committing an empty value clears the
// name back to the default label.
function DraftName(props: {
  name: string | null;
  fallback: string;
  onRename: (name: string | null) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  return (
    <Show
      when={editing()}
      fallback={
        <span
          class="draft-name"
          title="Double-click to rename"
          onDblClick={() => setEditing(true)}
        >
          {props.name ?? props.fallback}
        </span>
      }
    >
      <input
        class="draft-name-input"
        value={props.name ?? ""}
        placeholder={props.fallback}
        // Focus once mounted; the ref fires before insertion, hence the tick.
        ref={(el) => setTimeout(() => el.select())}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={(e) => {
          if (!editing()) return; // already cancelled via Escape
          setEditing(false);
          const value = e.currentTarget.value.trim();
          if (value !== (props.name ?? "")) props.onRename(value || null);
        }}
      />
    </Show>
  );
}

// The diff toggle in a card title, right-aligned. Open = diff highlighting
// showing. It holds no state: open/closed is derived from the checkpoint's
// baselines and toggling rewrites them (see `toggleEye`). Disabled on a live
// main view, where there is nothing to diff against — via aria-disabled
// rather than the disabled attribute, so the explanatory tooltip still shows
// on hover (browsers don't reliably show titles on disabled buttons).
function EyeToggle(props: {
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      class="draft-card-eye"
      data-active={props.open ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      aria-disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (props.disabled) return;
        props.onToggle();
      }}
      title={
        props.disabled
          ? "Nothing to compare yet — select a version in the timeline first"
          : props.open
            ? "Hide changes"
            : "Show what changed"
      }
    >
      <Show when={props.open} fallback={<EyeOffIcon />}>
        <EyeIcon />
      </Show>
    </button>
  );
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

// A reference to one change in the interleaved timeline, by document and
// hash. `time` steers how the *other* member docs' heads are resolved around
// it (see `computeCheckpoint`).
type ChangeRef = {
  docUrl: AutomergeUrl;
  hash: string;
  time: number;
};

// Where the scrubber sits: the change whose heads the view displays,
// anchored to its cached group. `offset` is the change's position within the
// group, 0 = the group's newest change (what the scrubber geometry snaps
// to); `head` identifies the exact change for the checkpoint machinery.
// `groupStartTime` is the group's span start, carried so the checkpoint's
// diff baseline can anchor at the group's beginning while the eye is on.
type ScrubberState = {
  groupId: string;
  offset: number;
  head: ChangeRef;
  groupStartTime: number;
};

// Where the diff baseline handle sits: an absolute point in history the diff
// is measured from, independent of the head. `time` resolves each member's
// `from` (see `computeCheckpoint`); `groupId`/`offset` place the handle in the
// track (same geometry as the head). `offset` of `BASELINE_GROUP_START` means
// "the start of the group" — the changes list resolves it to the group's
// oldest change once it knows the group's size. Ephemeral like `ScrubberState`.
type BaselineState = {
  groupId: string;
  offset: number;
  time: number;
};

// Sentinel `BaselineState.offset` meaning "the group's start" (its oldest
// change / the bottom of its band), used when the eye seeds the handle before
// the group's change count is known.
const BASELINE_GROUP_START = -1;

// One change recovered by the on-demand scrub-resolution scan. `doc` is the
// member doc it was read from (kept so the sticker can diff it on demand);
// `seq` is the change's per-document causal index, used only to break
// same-second timestamp ties — matching the fill engine's interleave order.
type ScanChange = {
  docUrl: AutomergeUrl;
  doc: Automerge.Doc<unknown>;
  hash: string;
  time: number;
  deps: string[];
  seq: number;
};

// Renders a draft's (or main's) timeline straight from its change-group
// cache doc: the provider's fill engine computes and persists the activity
// groups (newest first, older history backfilling), and this component is a
// pure reader — it paints from the cache before the member docs even load,
// and live edits arrive through the cache doc's change signal. A gutter on
// the left spans the whole history (top = latest version, bottom = first);
// the indicator — a calendar-style dot + line — marks the version being
// looked at and paints *on top* of everything in the changes area.
// Dragging starts only from its handles in the gutter; dragging it all the
// way to the top returns to the latest version (`onReturnToLatest`). While
// pinned, a sticker overlays the row at the head with the exact change the
// line sits on. Individual changes are NOT cached: scrub positions resolve
// on demand by scanning the member docs' change metadata inside the group's
// time span (no diffs), memoized per group so dragging stays snappy.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  changeGroupCacheUrl: AutomergeUrl | null;
  mainDocUrl: AutomergeUrl | undefined;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onBaselineScrub: (base: BaselineState) => void;
  baseliner: Accessor<BaselineState | null>;
  eyeOpen: Accessor<boolean>;
  onDragVersion: (head: ChangeRef | null) => void;
  onReturnToLatest: () => void;
}) {
  const repo = "repo" in window ? window.repo : undefined;

  // The cache doc, resolved from the summary's changeGroupCacheUrl and read
  // live: the fill engine's background writes stream in as timeline rows.
  const [cacheHandle, setCacheHandle] =
    createSignal<DocHandle<ChangeGroupCacheDoc>>();
  createEffect(() => {
    const url = props.changeGroupCacheUrl;
    setCacheHandle(undefined);
    if (!url || !repo) return;
    let disposed = false;
    void repo.find<ChangeGroupCacheDoc>(url).then(
      (handle) => {
        if (!disposed) setCacheHandle(handle);
      },
      (err) => {
        console.warn("[drafts] failed to load change-group cache:", url, err);
      }
    );
    onCleanup(() => {
      disposed = true;
    });
  });
  const cacheDoc = createDocSignal(cacheHandle);

  // The rendered rows: cached groups newest-first. Groups whose changes
  // carry no edits (metadata-only churn — zero +/- counts) are stored in the
  // cache (the fill engine needs the newest one to extend) but filtered here.
  const timeGroups = createMemo<CachedGroup[]>(() =>
    Object.values(cacheDoc()?.groups ?? {})
      .filter((g) => g.additions > 0 || g.deletions > 0)
      .sort((a, b) => b.endTime - a.endTime || (a.id < b.id ? -1 : 1))
  );

  // Member doc handles (plus the creation-time cutoff), resolved once per
  // member set — only needed to *scrub*, never to render the rows.
  type MemberSource = { member: DraftMemberDoc; handle: DocHandle<unknown> };
  const [sources, setSources] = createSignal<MemberSource[] | null>(null);
  const [createdAt, setCreatedAt] = createSignal<number | undefined>(
    undefined
  );
  createEffect(() => {
    const list = props.members();
    const mainDocUrl = props.mainDocUrl;
    if (!repo) return;
    let disposed = false;
    setSources(null);
    void (async () => {
      const next: MemberSource[] = [];
      for (const member of list) {
        try {
          const handle = await repo.find<unknown>(
            member.cloneUrl ?? member.url
          );
          next.push({ member, handle });
        } catch (err) {
          console.warn(
            "[drafts] failed to resolve member for scrubbing:",
            member,
            err
          );
        }
      }
      const created = await getDocCreationTime(repo, mainDocUrl);
      if (disposed) return;
      setCreatedAt(created);
      setSources(next);
    })();
    onCleanup(() => {
      disposed = true;
    });
  });

  // Recover a group's member changes on demand: scan each member's post-fork
  // change metadata filtered to the group's span (spans are disjoint — groups
  // are separated by >gap lulls, so time containment recovers exactly the
  // group's changes) and interleave with the same ordering the fill engine
  // uses. Metadata only, no diffs. Memoized per group identity so dragging
  // stays snappy; returns null until the member handles resolve. Must apply
  // the same filters as the fill (notably the pre-creation cutoff), or the
  // scrubber's index math drifts from the cached changeCount.
  const scanCache = new Map<string, ScanChange[]>();
  const resolveGroupChanges = (group: CachedGroup): ScanChange[] | null => {
    const key = `${group.id}:${group.changeCount}`;
    const hit = scanCache.get(key);
    if (hit) return hit;
    const srcs = sources();
    if (!srcs) return null;
    const cutoff = createdAt();
    const rows: ScanChange[] = [];
    for (const { member, handle } of srcs) {
      const doc = handle.doc() as Automerge.Doc<unknown> | undefined;
      if (!doc) continue;
      try {
        const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
        const metas = Automerge.getChangesMetaSince(doc, since);
        metas.forEach((meta, seq) => {
          if (cutoff !== undefined && meta.time && meta.time < cutoff) return;
          if (meta.time < group.startTime || meta.time > group.endTime) return;
          rows.push({
            docUrl: member.url,
            doc,
            hash: meta.hash,
            time: meta.time,
            deps: meta.deps,
            seq,
          });
        });
      } catch (err) {
        console.warn(
          "[drafts] failed to scan changes for member:",
          member,
          err
        );
      }
    }
    rows.sort((a, b) => b.time - a.time || b.seq - a.seq);
    scanCache.set(key, rows);
    return rows;
  };

  // Build the head scrub state for `offset` within `group` (0 = the group's
  // newest change, which the cache anchors directly; deeper offsets resolve
  // through the on-demand scan). Null while the scan is still resolving.
  const buildHead = (
    group: CachedGroup,
    offset: number
  ): ScrubberState | null => {
    if (offset <= 0) {
      return {
        groupId: group.id,
        offset: 0,
        head: {
          docUrl: group.newestMemberUrl,
          hash: group.newestHash,
          time: group.endTime,
        },
        groupStartTime: group.startTime,
      };
    }
    const rows = resolveGroupChanges(group);
    if (!rows || rows.length === 0) return null;
    const row = rows[Math.min(offset, rows.length - 1)];
    return {
      groupId: group.id,
      offset,
      head: { docUrl: row.docUrl, hash: row.hash, time: row.time },
      groupStartTime: group.startTime,
    };
  };

  // Expand the BASELINE_GROUP_START sentinel to the group's oldest change.
  const resolveOffset = (group: CachedGroup, offset: number): number =>
    offset === BASELINE_GROUP_START
      ? Math.max(0, group.changeCount - 1)
      : offset;

  // The change time at `offset` within `group` (0 = the group's newest
  // change). Used to resolve the baseline handle's `from` time.
  const timeAt = (group: CachedGroup, offset: number): number => {
    const resolved = resolveOffset(group, offset);
    if (resolved <= 0) return group.endTime;
    const rows = resolveGroupChanges(group);
    if (!rows || rows.length === 0) return group.startTime;
    return rows[Math.min(resolved, rows.length - 1)].time;
  };

  // A position's rank in the flat change order (higher = older), so the head
  // and baseline can be compared for clamping. Offsets are resolved (sentinel
  // -> group start) and clamped within their group.
  const linearIndex = (groupId: string, offset: number): number => {
    let acc = 0;
    for (const b of bands()) {
      const count = Math.max(1, b.group.changeCount);
      if (b.group.id === groupId) {
        return acc + Math.min(Math.max(0, resolveOffset(b.group, offset)), count - 1);
      }
      acc += count;
    }
    return acc + Math.max(0, offset);
  };

  // Move the head to `offset` within `group`. With the eye open the baseline
  // stays put (absolute), except that dragging the head older than the
  // baseline pushes the baseline down with it — they can meet but not cross.
  // The baseline is pushed first so the diff never momentarily inverts.
  const scrubTo = (group: CachedGroup, offset: number) => {
    const head = buildHead(group, offset);
    if (!head) return;
    if (props.eyeOpen()) {
      const bl = props.baseliner();
      if (
        bl &&
        linearIndex(head.groupId, head.offset) >
          linearIndex(bl.groupId, bl.offset)
      ) {
        props.onBaselineScrub({
          groupId: group.id,
          offset: head.offset,
          time: head.head.time,
        });
      }
    }
    props.onScrub(head);
  };

  // Select a group (click on its row): the head pins to the group's newest
  // change, and — with the eye open — the baseline re-anchors to the group's
  // start, so the diff reads "everything this group changed". Dragging the
  // head, by contrast, leaves the baseline where it is (see `scrubTo`).
  const selectGroup = (group: CachedGroup) => {
    if (props.eyeOpen()) {
      props.onBaselineScrub({
        groupId: group.id,
        offset: BASELINE_GROUP_START,
        time: group.startTime,
      });
    }
    scrubTo(group, 0);
  };

  // Move the baseline to `offset` within `group`, clamped so it never crosses
  // above (newer than) the head — the diff always reads old -> new. When the
  // clamp bites, the baseline snaps to the head (an empty diff).
  const baselineScrubTo = (group: CachedGroup, offset: number) => {
    const head = props.scrubber();
    if (!head) return;
    if (linearIndex(group.id, offset) < linearIndex(head.groupId, head.offset)) {
      props.onBaselineScrub({
        groupId: head.groupId,
        offset: head.offset,
        time: head.head.time,
      });
      return;
    }
    props.onBaselineScrub({
      groupId: group.id,
      offset,
      time: timeAt(group, offset),
    });
  };

  // The group the scrubber head sits in: by group identity when it still
  // exists, falling back to span containment (an extended group gets a new
  // id, but its span still covers the pinned change).
  const groupForScrub = (s: ScrubberState): CachedGroup | null =>
    timeGroups().find((g) => g.id === s.groupId) ??
    timeGroups().find(
      (g) => s.head.time >= g.startTime && s.head.time <= g.endTime
    ) ??
    null;

  // --- Scrubber geometry ---------------------------------------------------
  // The track mirrors the rows column: each group row is one vertical band,
  // and the group's changes distribute evenly across the band's height, so
  // every individual change — including ones in the middle of a group — is a
  // valid stop for the token, not just group boundaries.
  const rowEls = new Map<string, HTMLElement>();
  const [rowsEl, setRowsEl] = createSignal<HTMLDivElement>();
  // Bumped after layout changes so `bands` re-measures the rendered rows.
  const [measureTick, setMeasureTick] = createSignal(0);

  createEffect(() => {
    const el = rowsEl();
    if (!el) return;
    const observer = new ResizeObserver(() => setMeasureTick((t) => t + 1));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  // Rows render after the groups memo recomputes, so measure again on the
  // next frame once the DOM has settled.
  createEffect(() => {
    timeGroups();
    requestAnimationFrame(() => setMeasureTick((t) => t + 1));
  });

  type Band = {
    group: CachedGroup;
    top: number;
    height: number;
  };
  const bands = createMemo<Band[]>(() => {
    measureTick();
    const out: Band[] = [];
    for (const group of timeGroups()) {
      const el = rowEls.get(group.id);
      if (el) {
        out.push({ group, top: el.offsetTop, height: el.offsetHeight });
      }
    }
    return out;
  });

  // A scrub position's y in the track: offsets interpolate across their
  // group's band, sized by the cached changeCount (the flat change list is
  // never materialized).
  const yForPosition = (band: Band, offset: number): number => {
    const count = Math.max(1, band.group.changeCount);
    return band.top + (Math.min(offset, count - 1) / count) * band.height;
  };

  // Inverse: the (group, offset) position nearest a pointer y (in track
  // coordinates).
  const positionForY = (
    y: number
  ): { group: CachedGroup; offset: number } | null => {
    const bs = bands();
    if (bs.length === 0) return null;
    for (const b of bs) {
      if (y < b.top) return { group: b.group, offset: 0 };
      if (y < b.top + b.height) {
        const count = Math.max(1, b.group.changeCount);
        const offset = Math.min(
          Math.round(((y - b.top) / b.height) * count),
          count - 1
        );
        return { group: b.group, offset };
      }
    }
    const last = bs[bs.length - 1];
    return {
      group: last.group,
      offset: Math.max(0, last.group.changeCount - 1),
    };
  };

  // The indicator's pixel position: the head line's y in the track. The
  // zero-height box is fine — the dot and line overflow it and stay
  // grabbable. With nothing pinned it idles at the very top — you're looking
  // at the live latest.
  const tokenGeometry = createMemo(() => {
    const bs = bands();
    if (bs.length === 0) return null;
    const s = props.scrubber();
    if (!s) return { top: bs[0].top };
    const group = groupForScrub(s);
    const band = group ? bs.find((b) => b.group.id === group.id) : undefined;
    if (!band) return { top: bs[0].top };
    return { top: yForPosition(band, s.offset) };
  });

  // The baseline handle's y in the track, or null when it should not show:
  // only while the eye is open and a version is pinned (a head is set). Idle
  // on the latest version there is no baseline to drag.
  const baselineGeometry = createMemo(() => {
    if (!props.eyeOpen() || !props.scrubber()) return null;
    const b = props.baseliner();
    if (!b) return null;
    const bs = bands();
    const band =
      bs.find((x) => x.group.id === b.groupId) ??
      bs.find((x) => b.time >= x.group.startTime && b.time <= x.group.endTime);
    if (!band) return null;
    return { top: yForPosition(band, resolveOffset(band.group, b.offset)) };
  });

  let trackEl: HTMLDivElement | undefined;

  // Pointer y relative to the track's top edge. The rect is re-read per event
  // so scrolling the card mid-drag stays accurate.
  const yInTrack = (ev: PointerEvent): number => {
    const rect = trackEl!.getBoundingClientRect();
    return ev.clientY - rect.top;
  };

  // Begin an indicator drag: the head follows the pointer (offset by where
  // the indicator was grabbed). Scrubbing starts only from the indicator's
  // own handles (dot, line) — the bare gutter and the rows don't scrub.
  // Every position snaps to an individual change, so the indicator can rest
  // anywhere in history — between groups or in the middle of one. Dragging
  // all the way to the top (the newest change) means "return to the latest
  // version": it drops the pin rather than freezing at the newest change.
  const beginDrag = (ev: PointerEvent) => {
    if (!trackEl || bands().length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const grabOffset = yInTrack(ev) - (tokenGeometry()?.top ?? 0);

    const s = props.scrubber();
    let last = s ? `${s.groupId}:${s.offset}` : null;
    const onMove = (e: PointerEvent) => {
      const pos = positionForY(yInTrack(e) - grabOffset);
      if (!pos) return;
      const key = `${pos.group.id}:${pos.offset}`;
      if (key === last) return;
      last = key;
      const first = bands()[0];
      if (first && pos.group.id === first.group.id && pos.offset === 0) {
        props.onReturnToLatest();
      } else {
        scrubTo(pos.group, pos.offset);
      }
    };

    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Begin a baseline-handle drag: the baseline follows the pointer, clamped so
  // it never crosses above the head (see `baselineScrubTo`). Unlike the head,
  // it has no return-to-latest gesture — the baseline is only meaningful while
  // pinned, so there is nowhere at the top to drop it.
  const beginBaselineDrag = (ev: PointerEvent) => {
    if (!trackEl || bands().length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const grabOffset = yInTrack(ev) - (baselineGeometry()?.top ?? 0);

    let last: string | null = null;
    const onMove = (e: PointerEvent) => {
      const pos = positionForY(yInTrack(e) - grabOffset);
      if (!pos) return;
      const key = `${pos.group.id}:${pos.offset}`;
      if (key === last) return;
      last = key;
      baselineScrubTo(pos.group, pos.offset);
    };

    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Start a native drag carrying a version out of the timeline. The payload
  // rides in a component signal (source and drop zone share the panel);
  // dataTransfer is only set so the browser actually starts the drag.
  const beginVersionDrag = (ev: DragEvent, head: ChangeRef) => {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.setData("text/plain", `${head.docUrl}#${head.hash}`);
    ev.dataTransfer.effectAllowed = "copy";
    props.onDragVersion(head);
  };

  // The exact change the scrubber head sits on, recovered through the
  // on-demand scan; feeds the sticker that overlays the group row with the
  // version being looked at. It is suppressed when the head sits exactly on
  // a group's newest change (the row already shows that version).
  const headChange = createMemo<ScanChange | null>(() => {
    const s = props.scrubber();
    if (!s || s.offset === 0) return null;
    const group = groupForScrub(s);
    if (!group || s.head.hash === group.newestHash) return null;
    const rows = resolveGroupChanges(group);
    if (!rows || rows.length === 0) return null;
    return (
      rows.find(
        (r) => r.hash === s.head.hash && r.docUrl === s.head.docUrl
      ) ??
      rows[Math.min(s.offset, rows.length - 1)] ??
      null
    );
  });

  // The sticker's per-change +/- counts: one on-demand diff of the single
  // change under the head (the cache stores only group aggregates).
  const headCounts = createMemo(() => {
    const change = headChange();
    if (!change) return null;
    return computeEditCounts(change.doc, change.hash, change.deps);
  });

  // The sticker's title, resolved lazily per member doc and cached.
  const [titles, setTitles] = createSignal<Record<string, string>>({});
  createEffect(() => {
    const change = headChange();
    if (!change) return;
    if (titles()[change.docUrl] !== undefined) return;
    void resolveDocTitle(change.doc, change.docUrl).then((title) => {
      setTitles((t) => ({ ...t, [change.docUrl]: title }));
    });
  });
  const headTitle = (): string => {
    const change = headChange();
    if (!change) return "";
    return titles()[change.docUrl] ?? shortUrl(change.docUrl);
  };

  return (
    <div class="draft-card-changes">
      <Show
        when={timeGroups().length > 0}
        fallback={<div class="draft-changes-empty">No changes yet.</div>}
      >
        <div class="draft-changes-body">
          <div class="draft-scrubber" ref={trackEl} />
          <div class="draft-changes-rows" ref={setRowsEl}>
            <For each={timeGroups()}>
              {(group) => (
                <TimeGroupRow
                  group={group}
                  rowRef={(el) => rowEls.set(group.id, el)}
                  onSelect={() => selectGroup(group)}
                  onVersionDragStart={(e) =>
                    beginVersionDrag(e, {
                      docUrl: group.newestMemberUrl,
                      hash: group.newestHash,
                      time: group.endTime,
                    })
                  }
                  onVersionDragEnd={() => props.onDragVersion(null)}
                />
              )}
            </For>
          </div>
          <Show when={tokenGeometry()}>
            <div
              class="draft-scrubber-token"
              style={{ top: `${tokenGeometry()!.top}px` }}
            >
              {/* The head line, painted on top of the group rows. */}
              <div class="draft-scrubber-line" />
              {/* Grab handle, confined to the gutter. */}
              <div
                class="draft-scrubber-edge"
                title="Drag to scrub through history — drop at the top to return to the latest version"
                onPointerDown={beginDrag}
              />
              <div
                class="draft-scrubber-dot"
                title="Drag to scrub through history — drop at the top to return to the latest version"
                onPointerDown={beginDrag}
              />
              {/* Pinned inside a group: overlay the row with the exact
                  version the head sits on. Draggable — dragging it out forks
                  a new draft at that version. */}
              <Show when={headChange()}>
                {(change) => (
                  <div
                    class="draft-scrubber-sticker"
                    draggable={true}
                    title="Drag out to fork a new draft from this version"
                    onDragStart={(e) =>
                      beginVersionDrag(e, {
                        docUrl: change().docUrl,
                        hash: change().hash,
                        time: change().time,
                      })
                    }
                    onDragEnd={() => props.onDragVersion(null)}
                  >
                    <span class="draft-sticker-time">
                      {formatTime(change().time)}
                    </span>
                    <span class="draft-sticker-title">{headTitle()}</span>
                    <span class="draft-sticker-spacer" />
                    <EditCounts
                      additions={headCounts()?.additions ?? 0}
                      deletions={headCounts()?.deletions ?? 0}
                    />
                  </div>
                )}
              </Show>
            </div>
          </Show>
          {/* The diff baseline: a second handle (line + hollow circle) shown
              only with the eye open and a version pinned. Independent of the
              head — dragging it re-anchors the diff's older bound — and joined
              to the head by a connector so the two read as one range. */}
          <Show when={baselineGeometry()}>
            <div
              class="draft-scrubber-connector"
              style={{
                top: `${Math.min(tokenGeometry()?.top ?? 0, baselineGeometry()!.top)}px`,
                height: `${Math.abs((tokenGeometry()?.top ?? 0) - baselineGeometry()!.top)}px`,
              }}
            />
            <div
              class="draft-scrubber-token draft-scrubber-token--baseline"
              style={{ top: `${baselineGeometry()!.top}px` }}
            >
              <div class="draft-scrubber-line" />
              <div
                class="draft-scrubber-edge"
                title="Drag to move the diff baseline"
                onPointerDown={beginBaselineDrag}
              />
              <div
                class="draft-scrubber-baseline"
                title="Drag to move the diff baseline"
                onPointerDown={beginBaselineDrag}
              />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// One time group, rendered as a single non-expandable row: author avatars,
// the group's newest timestamp, and the aggregated +/- counts. Clicking the
// row parks the scrubber at the top of the group (the scrubber token is the
// selection indicator — the row itself doesn't highlight). Dragging the row
// out forks a new draft at the group's newest change (the same version
// clicking pins); dragstart only fires past the movement threshold, so
// click-to-select is unaffected.
function TimeGroupRow(props: {
  group: CachedGroup;
  rowRef: (el: HTMLElement) => void;
  onSelect: () => void;
  onVersionDragStart: (e: DragEvent) => void;
  onVersionDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      class="draft-group-row"
      ref={props.rowRef}
      title="View the draft as of this group — drag out to fork a draft from it"
      onClick={props.onSelect}
      draggable={true}
      onDragStart={props.onVersionDragStart}
      onDragEnd={props.onVersionDragEnd}
    >
      <AuthorAvatars actors={props.group.actors} />
      <span class="draft-group-time">{formatTime(props.group.endTime)}</span>
      <span class="draft-group-spacer" />
      <EditCounts
        additions={props.group.additions}
        deletions={props.group.deletions}
      />
    </button>
  );
}

// A stack of author avatars (deduped), newest-contributor first.
function AuthorAvatars(props: { actors: string[] }) {
  const visible = () => props.actors.slice(0, 3);
  const extra = () => Math.max(0, props.actors.length - 3);
  return (
    <div class="draft-avatars">
      <For each={visible()}>
        {(actor, i) => (
          <div
            class="draft-avatar"
            title={actor}
            style={{
              background: authorColor(actor),
              "margin-left": i() === 0 ? "0" : "-4px",
              "z-index": String(visible().length - i()),
            }}
          >
            {getInitials(actor)}
          </div>
        )}
      </For>
      <Show when={extra() > 0}>
        <div class="draft-avatar draft-avatar--extra">+{extra()}</div>
      </Show>
    </div>
  );
}

// The +N / -N edit-size counts shown at the end of a group row.
function EditCounts(props: { additions: number; deletions: number }) {
  return (
    <span class="draft-counts">
      <Show when={props.additions > 0}>
        <span class="draft-count draft-count--add">+{props.additions}</span>
      </Show>
      <Show when={props.deletions > 0}>
        <span class="draft-count draft-count--del">-{props.deletions}</span>
      </Show>
    </span>
  );
}

// Diff baseline mode for a checkpoint. `"none"` writes no `from` (no diff);
// `{ beforeTime }` anchors each member's `from` at its state just before that
// absolute time — the draggable baseline handle's position — so everything
// from there up to the head reads as the diff. The baseline is independent of
// the head (see `onScrub`/`onBaselineScrub`): the two are resolved separately
// and only clamped so the baseline stays at or older than the head.
type CheckpointBase = "none" | { beforeTime: number };

// Build the checkpoint map for a scrub position. Each member's displayed
// version (`to`) is its heads as of `head`: the doc that owns that change is
// pinned exactly to it, every other member to its latest change at or before
// it (approximate but good enough). The diff baseline (`from`) follows
// `base`: omitted for `"none"`, or the member's heads just before
// `beforeTime` (falling back to the fork point — empty heads on main — when
// no post-fork change precedes it). Members with no change at or before
// `head` are omitted entirely: they didn't exist yet, so they fall through to
// live.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  head: ChangeRef,
  base: CheckpointBase
): Promise<DraftCheckpoint> {
  const checkpoint: DraftCheckpoint = {};
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);

      // Displayed version: exactly the head change for the doc that owns it,
      // otherwise the member's latest change at or before it.
      let to: UrlHeads;
      if (member.url === head.docUrl) {
        // Pin the head's doc exactly even if it falls outside the metas
        // window (robust against a mismatched fork point).
        to = encodeHeads([head.hash]);
      } else {
        let pinnedIndex = -1;
        let bestTime = -Infinity;
        metas.forEach((m, i) => {
          if (m.time <= head.time && m.time >= bestTime) {
            bestTime = m.time;
            pinnedIndex = i;
          }
        });
        if (pinnedIndex < 0) continue;
        to = encodeHeads([metas[pinnedIndex].hash]);
      }

      if (base === "none") {
        checkpoint[member.url] = { to };
        continue;
      }

      // Diff baseline: the member's newest change strictly before the
      // baseline's time. None post-fork means the baseline sits at or before
      // the start of the member's history in this timeline, so diff against
      // the fork point (empty heads on main — the whole doc reads as added).
      let fromIndex = -1;
      let fromTime = -Infinity;
      metas.forEach((m, i) => {
        if (m.time < base.beforeTime && m.time >= fromTime) {
          fromTime = m.time;
          fromIndex = i;
        }
      });
      const from =
        fromIndex >= 0
          ? encodeHeads([metas[fromIndex].hash])
          : (member.clonedAt ?? encodeHeads([]));
      checkpoint[member.url] = { from, to };
    } catch (err) {
      console.warn(
        "[drafts] failed to compute checkpoint for member:",
        member,
        err
      );
    }
  }
  return checkpoint;
}

// Resolve a document's display title: prefer its cached `@patchwork.title`,
// otherwise ask its datatype for one, falling back to a short url. Mirrors the
// sideboard's `docLinkFromUrl` but reuses an already-loaded doc.
async function resolveDocTitle(
  doc: unknown,
  url: AutomergeUrl
): Promise<string> {
  try {
    const meta = (doc as { "@patchwork"?: { title?: string; type?: string } })[
      "@patchwork"
    ];
    if (typeof meta?.title === "string" && meta.title) return meta.title;

    const type = meta?.type;
    if (type) {
      const registry = getRegistry("patchwork:datatype");
      const datatype = registry.get(type);
      if (datatype) {
        await registry.load(datatype.id);
        if (isLoadedPlugin(datatype)) {
          const title = datatype.module.getTitle(doc);
          if (title) return title;
        }
      }
    }
  } catch (err) {
    console.warn("[drafts] failed to resolve title for:", url, err);
  }
  return shortUrl(url);
}

// "automerge:4NMNnk…AVdXu" → a compact, fixed-width label for a doc url.
function shortUrl(url: AutomergeUrl): string {
  const id = url.replace(/^automerge:/, "");
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

// A stable-ish color for an author, so the same person reads the same across
// rows. Actors are Automerge actor ids (per device/session), the best "who"
// signal available in a draft's raw change history.
function authorColor(authorId: string): string {
  let hash = 0;
  for (let i = 0; i < authorId.length; i++) {
    hash = authorId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 63%)`;
}

// Two short characters to stand in for an author on their avatar.
function getInitials(authorId: string): string {
  return authorId.slice(0, 2).toUpperCase();
}

// Ticks so relative timestamps ("5 minutes ago") stay fresh while the panel
// is open. Module-level: one timer serves every row of every card, and it
// lives as long as the module does.
const [nowMs, setNowMs] = createSignal(Date.now());
setInterval(() => setNowMs(Date.now()), 30_000);

// `numeric: "auto"` gives GitHub's phrasing: "yesterday" and "last week"
// instead of "1 day ago" and "1 week ago".
const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

// Format an Automerge change time (Unix SECONDS) the way GitHub's
// <relative-time> element formats timeline times: relative while recent
// ("now", "5 minutes ago", "5 hours ago", "yesterday", "last week"), and
// past 30 days an absolute short date ("Jun 13"), with the year appended
// only once it differs from the current one ("Jun 13, 2025").
function formatTime(timeSeconds: number): string {
  if (!timeSeconds) return "";
  const date = new Date(timeSeconds * 1000);
  const seconds = Math.max(0, Math.floor((nowMs() - date.getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return "now";
  if (hours < 1) return RELATIVE_TIME.format(-minutes, "minute");
  if (days < 1) return RELATIVE_TIME.format(-hours, "hour");
  if (days < 7) return RELATIVE_TIME.format(-days, "day");
  if (days < 30) return RELATIVE_TIME.format(-Math.floor(days / 7), "week");
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date(nowMs()).getFullYear()
        ? undefined
        : "numeric",
  });
}
