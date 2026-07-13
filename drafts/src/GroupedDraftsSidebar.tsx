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
  CheckedOutDraft,
  CloneEntry,
  DraftCheckpoint,
  DraftDoc,
  DraftList,
  DraftMemberDoc,
  HasDrafts,
} from "./draft-types";

// Seed for the read-only `draft:list` subscription until the provider answers.
// `main.url` is a placeholder; the Main card displays the host doc url instead.
const EMPTY_DRAFT_LIST: DraftList = {
  main: { url: "" as AutomergeUrl, members: [], childCount: 0, name: null },
  drafts: [],
};

// Bump on each deploy to eyeball whether the latest build has synced.
const DRAFTS_VERSION = "0.0.18";

// Logged at module load so the console shows which build is running even
// before the panel renders.
console.log(`[drafts] GroupedDraftsSidebar v${DRAFTS_VERSION} loaded`);

// A pause between consecutive changes longer than this starts a new group:
// bursts of continuous editing read as a single row, however long they run,
// and any minute-plus lull splits the timeline.
const INACTIVITY_GAP = 60 * 1000;

export function GroupedDraftsSidebar(props: { element: HTMLElement }) {
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

  // Where the scrubber sits: the change whose heads are displayed. Ephemeral,
  // client-only state: the stored checkpoint (`checkedOut.at`) is what
  // actually pins the view; this mirrors it to render the token and the
  // group highlight. Not persisted, so it resets on reload (the pinned view
  // survives).
  const [scrubber, setScrubber] = createSignal<ScrubberState | null>(null);

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

  // Apply a scrubber position: freeze every member doc at its heads as of the
  // scrub head. The token and row highlight update immediately; the
  // checkpoint follows async. `draftUrl` is `null` for main.
  const onScrub = (
    draftUrl: AutomergeUrl | null,
    members: DraftMemberDoc[],
    scrub: ScrubberState
  ) => {
    const handle = checkedOutHandle();
    const repo = getRepo();
    if (!handle || !repo) return;
    setScrubber(scrub);
    const seq = ++scrubSeq;
    void (async () => {
      const checkpoint = await computeCheckpoint(repo, members, scrub.head);
      // A newer scrub landed while this one was computing; drop it.
      if (seq !== scrubSeq) return;
      handle.change((d) => {
        d.checkedOut = draftUrl;
        d.at = checkpoint;
      });
    })();
  };

  // Drop the time pin but stay on the same draft: back to live latest heads.
  const clearCheckpoint = () => {
    const handle = checkedOutHandle();
    if (!handle) return;
    setScrubber(null);
    handle.change((d) => {
      d.at = null;
    });
  };

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

  // Resolve the host doc's single main draft, creating it (and pointing
  // `@patchwork.mainDraftUrl` at it) the first time. The main draft is
  // bookkeeping only: the list provider seeds its identity `clones`, and its
  // `drafts` holds the top-level draft list.
  const ensureMainDraft = async (
    repo: Repo,
    docHandle: DocHandle<HasDrafts>
  ): Promise<DocHandle<DraftDoc>> => {
    const existingUrl = docHandle.doc()?.["@patchwork"]?.mainDraftUrl;
    if (existingUrl) return repo.find<DraftDoc>(existingUrl);

    const mainDraft = repo.create<DraftDoc>({
      "@patchwork": { type: "draft" },
      isMain: true,
      parent: docHandle.url,
      drafts: [],
      clones: {},
    });
    docHandle.change((d) => {
      // Mutate `@patchwork` in place. Spreading it into a fresh object and
      // reassigning would carry over references to existing document objects,
      // which Automerge rejects ("Cannot create a reference to an existing
      // document object").
      d["@patchwork"]!.mainDraftUrl = mainDraft.url;
    });
    return mainDraft;
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

    // Reuse the scrub machinery to resolve per-doc heads at this version.
    const checkpoint = await computeCheckpoint(repo, members, head);

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
            name={list().main.name}
            onRename={(name) => void onRename(null, name)}
            onSelect={() => selectDraft(null)}
            onScrub={(scrub) => onScrub(null, list().main.members, scrub)}
            scrubber={() => (isMainSelected() ? scrubber() : null)}
            onDragVersion={(head) =>
              setDragVersion(
                head ? { members: list().main.members, head } : null
              )
            }
            hasCheckpoint={isMainSelected() && !!checkedOut()?.at}
            onReturnToLatest={clearCheckpoint}
          />
          <For each={list().drafts}>
            {(summary) => (
              <DraftCard
                url={summary.url}
                members={summary.members}
                mainDocUrl={hostDocHandle()?.url}
                isSelected={selected() === summary.url}
                name={summary.name}
                onRename={(name) => void onRename(summary.url, name)}
                onSelect={selectDraft}
                onScrub={(scrub) => onScrub(summary.url, summary.members, scrub)}
                scrubber={() =>
                  selected() === summary.url ? scrubber() : null
                }
                onDragVersion={(head) =>
                  setDragVersion(
                    head ? { members: summary.members, head } : null
                  )
                }
                hasCheckpoint={
                  selected() === summary.url && !!checkedOut()?.at
                }
                onReturnToLatest={clearCheckpoint}
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
  const pinned = Automerge.loadIncremental(
    Automerge.init<unknown>(),
    bundle
  );

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
        topoRange:
          min <= max ? ([min, max] as [number, number]) : null,
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
  name: string | null;
  onRename: (name: string | null) => void;
  onSelect: () => void;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
  hasCheckpoint: boolean;
  onReturnToLatest: () => void;
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
          <Show when={props.isSelected}>
            <span class="draft-badge">current</span>
          </Show>
        </div>
      </div>
      <Show when={props.isSelected}>
        <DraftChangesList
          members={props.members}
          mainDocUrl={props.hostDocUrl}
          onScrub={props.onScrub}
          scrubber={props.scrubber}
          onDragVersion={props.onDragVersion}
        />
        <ReturnToLatestButton
          visible={props.hasCheckpoint}
          onClick={props.onReturnToLatest}
        />
      </Show>
    </div>
  );
}

function DraftCard(props: {
  url: AutomergeUrl;
  members: DraftMemberDoc[];
  mainDocUrl: AutomergeUrl | undefined;
  isSelected: boolean;
  name: string | null;
  onRename: (name: string | null) => void;
  onSelect: (url: AutomergeUrl) => void;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
  hasCheckpoint: boolean;
  onReturnToLatest: () => void;
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
          <Show when={props.isSelected}>
            <span class="draft-badge">current</span>
          </Show>
        </div>
      </div>
      <Show when={props.isSelected}>
        <DraftChangesList
          members={() => props.members}
          mainDocUrl={props.mainDocUrl}
          onScrub={props.onScrub}
          scrubber={props.scrubber}
          onDragVersion={props.onDragVersion}
        />
        <ReturnToLatestButton
          visible={props.hasCheckpoint}
          onClick={props.onReturnToLatest}
        />
      </Show>
    </div>
  );
}

// Card footer shown while the card's timeline is pinned to a checkpoint:
// drops the time pin and returns the view to the live latest heads. Rendered
// outside the scrollable changes area so it never scrolls out of reach.
function ReturnToLatestButton(props: { visible: boolean; onClick: () => void }) {
  return (
    <Show when={props.visible}>
      <button
        type="button"
        class="draft-card-return"
        onClick={props.onClick}
        title="Return to the latest version"
      >
        Return to latest
      </button>
    </Show>
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

// One change in the interleaved timeline. `docUrl` is the original member url
// (used for labelling and as the checkpoint anchor), never the per-draft clone
// the change was read from. `title` is the source document's display title.
// `seq` is the change's per-document causal index, used only to break
// timestamp ties (see `collectInterleavedChanges`). `additions`/`deletions`
// are the change's rough edit magnitude, aggregated for the group +/- counts.
type DraftChange = {
  docUrl: AutomergeUrl;
  title: string;
  hash: string;
  // Automerge change time, in SECONDS (multiply by 1000 for a JS Date).
  time: number;
  actor: string;
  message: string | null;
  seq: number;
  additions: number;
  deletions: number;
};

// One burst of activity: consecutive changes separated by no more than
// INACTIVITY_GAP, regardless of author or document. Rendered as a single
// non-expandable row. Clicking it parks the scrubber at `newest`.
type TimeGroup = {
  id: string;
  endTime: number;
  actors: string[];
  additions: number;
  deletions: number;
  newest: DraftChange;
  changes: DraftChange[];
};

// A reference to one change in the interleaved timeline, by document and
// hash. `time` steers how the *other* member docs' heads are resolved around
// it (see `computeCheckpoint`).
type ChangeRef = {
  docUrl: AutomergeUrl;
  hash: string;
  time: number;
};

// Where the scrubber sits: the change whose heads the view displays. The
// head is anchored by change identity rather than index so a recomputed
// timeline doesn't move the token.
type ScrubberState = {
  head: ChangeRef;
};

// Strip a timeline change down to the fields that identify it for scrubbing.
function changeRef(change: DraftChange): ChangeRef {
  return { docUrl: change.docUrl, hash: change.hash, time: change.time };
}

// Renders a draft's (or main's) changes as a timeline of activity groups:
// every member doc's changes interleaved newest first, then split wherever
// the editing paused for INACTIVITY_GAP (see `groupChanges`). A gutter on
// the left spans the whole history (top = latest change, bottom = first);
// the indicator — a calendar-style dot + line — marks the version being
// looked at. Its line paints *under* the (semi-transparent) group rows;
// dragging starts only from its handles in the gutter. While pinned, a
// sticker overlays the row at the head with the exact change the line sits
// on. The member set is passed in (from the card's `DraftSummary`); the
// effect below keeps the timeline live as those docs edit.
function DraftChangesList(props: {
  members: Accessor<DraftMemberDoc[]>;
  mainDocUrl: AutomergeUrl | undefined;
  onScrub: (scrub: ScrubberState) => void;
  scrubber: Accessor<ScrubberState | null>;
  onDragVersion: (head: ChangeRef | null) => void;
}) {
  const [changes, setChanges] = createSignal<DraftChange[]>([]);

  // Whenever the member set changes, resolve a handle per member, listen for
  // edits so the timeline stays live, and recompute. A `disposed` flag guards
  // against the async resolution landing after the effect was torn down.
  createEffect(() => {
    const list = props.members();
    const mainDocUrl = props.mainDocUrl;
    const repo = "repo" in window ? window.repo : undefined;
    if (!repo) return;

    let disposed = false;
    const listeners: { handle: DocHandle<unknown>; onChange: () => void }[] =
      [];

    const recompute = async () => {
      const next = await collectInterleavedChanges(repo, list, mainDocUrl);
      if (!disposed) setChanges(next);
    };

    void (async () => {
      for (const member of list) {
        const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
        if (disposed) return;
        const onChange = () => void recompute();
        handle.on("change", onChange);
        listeners.push({ handle, onChange });
      }
      void recompute();
    })();

    onCleanup(() => {
      disposed = true;
      for (const { handle, onChange } of listeners) {
        handle.off("change", onChange);
      }
    });
  });

  // The flat, newest-first history folded into activity groups for rendering.
  // Groups whose changes carry no edits (metadata-only churn — zero +/-
  // counts) are dropped from the timeline entirely.
  const timeGroups = createMemo(() =>
    groupChanges(changes()).filter((g) => g.additions > 0 || g.deletions > 0)
  );

  // The scrubbable timeline: the visible groups' changes flattened
  // newest-first. All scrubber indices refer to this list, so it must stay
  // consistent with the rendered rows (not the raw, unfiltered history).
  const visibleChanges = createMemo(() =>
    timeGroups().flatMap((g) => g.changes)
  );

  // Scrub so the head sits at the timeline change at `headIndex` (global,
  // 0 = newest).
  const scrubTo = (headIndex: number) => {
    const head = visibleChanges()[headIndex];
    if (!head) return;
    props.onScrub({ head: changeRef(head) });
  };

  // Jump the scrubber to a group: head at the group's newest change.
  const scrubToGroup = (group: TimeGroup) => {
    props.onScrub({ head: changeRef(group.newest) });
  };

  // Where the scrubber head sits in the flat timeline; null when nothing is
  // pinned (live latest) or the anchored change vanished from a recompute.
  const headIndex = createMemo<number | null>(() => {
    const s = props.scrubber();
    if (!s) return null;
    const idx = visibleChanges().findIndex(
      (c) => c.hash === s.head.hash && c.docUrl === s.head.docUrl
    );
    return idx >= 0 ? idx : null;
  });

  const groupContainsHead = (group: TimeGroup): boolean => {
    const s = props.scrubber();
    return (
      !!s &&
      group.changes.some(
        (c) => c.hash === s.head.hash && c.docUrl === s.head.docUrl
      )
    );
  };

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
    startIndex: number;
    count: number;
    top: number;
    height: number;
  };
  const bands = createMemo<Band[]>(() => {
    measureTick();
    const out: Band[] = [];
    let index = 0;
    for (const group of timeGroups()) {
      const el = rowEls.get(group.id);
      if (el) {
        out.push({
          startIndex: index,
          count: group.changes.length,
          top: el.offsetTop,
          height: el.offsetHeight,
        });
      }
      index += group.changes.length;
    }
    return out;
  });

  // Map a global change index to a y offset in the track. Indices interpolate
  // across their group's band; an index past the oldest change maps to the
  // very bottom.
  const yForIndex = (index: number): number => {
    const bs = bands();
    if (bs.length === 0) return 0;
    for (const b of bs) {
      if (index < b.startIndex + b.count) {
        return b.top + ((index - b.startIndex) / b.count) * b.height;
      }
    }
    const last = bs[bs.length - 1];
    return last.top + last.height;
  };

  // Inverse: the change index nearest a pointer y (in track coordinates).
  const indexForY = (y: number): number => {
    const bs = bands();
    if (bs.length === 0) return 0;
    for (const b of bs) {
      if (y < b.top) return b.startIndex;
      if (y < b.top + b.height) {
        const idx =
          b.startIndex + Math.round(((y - b.top) / b.height) * b.count);
        return Math.min(idx, b.startIndex + b.count - 1);
      }
    }
    const last = bs[bs.length - 1];
    return Math.max(0, last.startIndex + last.count - 1);
  };

  // The indicator's pixel position: the head line's y in the track. The
  // zero-height box is fine — the dot and line overflow it and stay
  // grabbable. With nothing pinned it idles at the very top — you're looking
  // at the live latest.
  const tokenGeometry = createMemo(() => {
    if (visibleChanges().length === 0 || bands().length === 0) return null;
    return { top: yForIndex(headIndex() ?? 0) };
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
  // anywhere in history — between groups or in the middle of one.
  const beginDrag = (ev: PointerEvent) => {
    if (!trackEl || visibleChanges().length === 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const grabOffset = yInTrack(ev) - yForIndex(headIndex() ?? 0);

    let last = headIndex() ?? 0;
    const onMove = (e: PointerEvent) => {
      const head = indexForY(yInTrack(e) - grabOffset);
      if (head === last) return;
      last = head;
      scrubTo(head);
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

  // The exact change the scrubber head sits on; feeds the sticker that
  // overlays the group row with the version being looked at. It is
  // suppressed when the head sits exactly on a group's newest change (the
  // row already shows that version).
  const headChange = createMemo<DraftChange | null>(() => {
    const idx = headIndex();
    const change = idx === null ? null : (visibleChanges()[idx] ?? null);
    if (!change) return null;
    const atGroupStart = timeGroups().some(
      (g) => g.newest.hash === change.hash && g.newest.docUrl === change.docUrl
    );
    return atGroupStart ? null : change;
  });

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
                  isSelected={groupContainsHead(group)}
                  onSelect={() => scrubToGroup(group)}
                  onVersionDragStart={(e) =>
                    beginVersionDrag(e, changeRef(group.newest))
                  }
                  onVersionDragEnd={() => props.onDragVersion(null)}
                />
              )}
            </For>
          </div>
          <Show when={tokenGeometry()}>
            <div
              class="draft-scrubber-token"
              data-live={headIndex() === null ? "" : undefined}
              style={{ top: `${tokenGeometry()!.top}px` }}
            >
              {/* The head line, painted under the group rows. */}
              <div class="draft-scrubber-line" />
              {/* Grab handle, confined to the gutter. */}
              <div
                class="draft-scrubber-edge"
                title="Drag to scrub through history"
                onPointerDown={beginDrag}
              />
              <div
                class="draft-scrubber-dot"
                title="Drag to scrub through history"
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
                      beginVersionDrag(e, changeRef(change()))
                    }
                    onDragEnd={() => props.onDragVersion(null)}
                  >
                    <span class="draft-sticker-time">
                      {formatTime(change().time)}
                    </span>
                    <span class="draft-sticker-title">{change().title}</span>
                    <span class="draft-sticker-spacer" />
                    <EditCounts
                      additions={change().additions}
                      deletions={change().deletions}
                    />
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// One time group, rendered as a single non-expandable row: author avatars,
// the group's newest timestamp, and the aggregated +/- counts. Clicking the
// row parks the scrubber at the top of the group. The row highlights while
// the scrubber head sits inside the group. Dragging the row out forks a new
// draft at the group's newest change (the same version clicking pins);
// dragstart only fires past the movement threshold, so click-to-select is
// unaffected.
function TimeGroupRow(props: {
  group: TimeGroup;
  rowRef: (el: HTMLElement) => void;
  isSelected: boolean;
  onSelect: () => void;
  onVersionDragStart: (e: DragEvent) => void;
  onVersionDragEnd: () => void;
}) {
  return (
    <button
      type="button"
      class="draft-group-row"
      ref={props.rowRef}
      data-selected={props.isSelected ? "" : undefined}
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

// Fold a flat, newest-first list of changes into activity groups. Consecutive
// changes stay in the same group while the pause between them is at most
// INACTIVITY_GAP; a longer lull starts a new group. A group can span any
// stretch of continuous editing — only inactivity splits it.
function groupChanges(changes: DraftChange[]): TimeGroup[] {
  const timeGroups: TimeGroup[] = [];
  let window: DraftChange[] = [];
  let prevTimeMs: number | null = null;

  const flush = () => {
    if (window.length > 0) {
      timeGroups.push(buildTimeGroup(window));
      window = [];
    }
  };

  for (const change of changes) {
    const timeMs = change.time * 1000;
    // Rows arrive newest-first, so the previous row is this change's newer
    // neighbour; a gap larger than the threshold between them is a lull.
    if (prevTimeMs !== null && prevTimeMs - timeMs > INACTIVITY_GAP) flush();
    window.push(change);
    prevTimeMs = timeMs;
  }
  flush();

  return timeGroups;
}

// Build one group from a window of newest-first changes: dedupe the authors
// (newest contributor first) and aggregate the +/- counts.
function buildTimeGroup(windowNewestFirst: DraftChange[]): TimeGroup {
  const actors: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const c of windowNewestFirst) {
    if (!actors.includes(c.actor)) actors.push(c.actor);
    additions += c.additions;
    deletions += c.deletions;
  }
  const newest = windowNewestFirst[0];
  return {
    id: `tg-${newest.hash}`,
    endTime: newest.time,
    actors,
    additions,
    deletions,
    newest,
    changes: windowNewestFirst,
  };
}

// Build the checkpoint map for a scrub position. Each member's displayed
// version (`to`) is its heads as of `head`: the doc that owns that change is
// pinned exactly to it, every other member to its latest change at or before
// it (approximate but good enough). The diff baseline (`from`) is always the
// displayed heads themselves (no diff) — set explicitly (rather than
// omitted) so a draft doesn't fall back to its fork-point baseline and light
// up the whole draft diff. Members with no change at or before `head` are
// omitted entirely: they didn't exist yet, so they fall through to live.
async function computeCheckpoint(
  repo: Repo,
  members: DraftMemberDoc[],
  head: ChangeRef
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

      checkpoint[member.url] = { from: to, to };
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

// Collect every member doc's post-fork changes into one interleaved timeline,
// newest first. `getChangesMetaSince` returns each doc's changes in topological
// (causal, oldest-first) order, so we stamp each change with its per-document
// `seq` index and sort by time with `seq` as the tie-break: `meta.time` is only
// second-resolution, so changes sharing a timestamp fall back to their
// document's own change order rather than being shuffled. On a draft `clonedAt`
// is set, so reading the clone since that fork point yields exactly the draft's
// own changes; on main both clone fields are null, so we read the original doc
// since `[]` for its full history. Members with no changes are omitted.
//
// Changes that predate the root document's creation are dropped: a member doc
// dragged in after the fact (e.g. a tldraw with its own prior edit history)
// would otherwise contribute changes from before this document even existed,
// which reads as noise. When the cutoff can't be resolved we keep everything.
async function collectInterleavedChanges(
  repo: Repo,
  members: DraftMemberDoc[],
  mainDocUrl: AutomergeUrl | undefined
): Promise<DraftChange[]> {
  const rows: DraftChange[] = [];
  const createdAt = await getDocCreationTime(repo, mainDocUrl);
  for (const member of members) {
    try {
      const handle = await repo.find<unknown>(member.cloneUrl ?? member.url);
      const doc = handle.doc();
      if (!doc) continue;
      const since = member.clonedAt ? decodeHeads(member.clonedAt) : [];
      const metas = Automerge.getChangesMetaSince(doc, since);
      if (metas.length === 0) continue;
      const title = await resolveDocTitle(doc, member.url);
      metas.forEach((meta, seq) => {
        // Hide anything from before the root document was created. `seq` still
        // reflects the change's true per-document position, so dropping rows
        // here doesn't disturb the tie-break ordering.
        if (createdAt !== undefined && meta.time && meta.time < createdAt) {
          return;
        }
        const { additions, deletions } = computeEditCounts(
          doc as Automerge.Doc<unknown>,
          meta.hash,
          meta.deps
        );
        rows.push({
          docUrl: member.url,
          title,
          hash: meta.hash,
          time: meta.time,
          actor: meta.actor,
          message: meta.message,
          seq,
          additions,
          deletions,
        });
      });
    } catch (err) {
      // A member doc that can't be resolved (or whose fork point is missing)
      // is simply omitted rather than failing the whole list.
      console.warn("[drafts] failed to read changes for member:", member, err);
    }
  }
  // Newest first by timestamp. On a tie (meta.time is only second-resolution),
  // fall back to each document's own change order, also newest-first: `seq` is
  // the per-document causal index (oldest = 0), so the higher (later) seq sorts
  // first. This keeps same-second changes consistent with the newest-first
  // intent instead of flipping that run to oldest-first.
  rows.sort((a, b) => b.time - a.time || b.seq - a.seq);
  return rows;
}

// Work out one change's rough edit magnitude by diffing it against its parents
// and counting its patches: splice lengths and insert counts as additions, del
// lengths as deletions, everything else (put / inc / mark / …) as one addition.
// `@patchwork` metadata paths are ignored. Feeds the group +/- counts.
function computeEditCounts(
  doc: Automerge.Doc<unknown>,
  hash: string,
  deps: string[]
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  try {
    const patches = Automerge.diff(
      doc,
      deps as unknown as Automerge.Heads,
      [hash] as unknown as Automerge.Heads
    );
    for (const patch of patches) {
      if (patch.path[0] === "@patchwork") continue;
      if (patch.action === "splice") {
        additions += (patch.value as string).length;
      } else if (patch.action === "insert") {
        additions += Array.isArray((patch as { values?: unknown[] }).values)
          ? (patch as { values: unknown[] }).values.length
          : 1;
      } else if (patch.action === "del") {
        deletions += (patch as { length?: number }).length ?? 1;
      } else {
        additions += 1;
      }
    }
  } catch (err) {
    console.warn("[drafts] failed to diff change for edit counts:", hash, err);
  }
  return { additions, deletions };
}

// When was a document created, as a Unix SECONDS timestamp? Reads the doc's
// full history and returns its first change's time (the creation change).
// Returns undefined when the doc, its history, or that time can't be resolved,
// in which case callers skip the "before creation" filter rather than hiding
// everything.
async function getDocCreationTime(
  repo: Repo,
  url: AutomergeUrl | undefined
): Promise<number | undefined> {
  if (!url) return undefined;
  try {
    const handle = await repo.find<unknown>(url);
    const doc = handle.doc();
    if (!doc) return undefined;
    const metas = Automerge.getChangesMetaSince(doc, []);
    return metas[0]?.time || undefined;
  } catch (err) {
    console.warn("[drafts] failed to resolve creation time for:", url, err);
    return undefined;
  }
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

// Format an Automerge change time (Unix SECONDS) as a short local timestamp.
function formatTime(timeSeconds: number): string {
  if (!timeSeconds) return "";
  const date = new Date(timeSeconds * 1000);
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return `${datePart}, ${timePart}`;
}
