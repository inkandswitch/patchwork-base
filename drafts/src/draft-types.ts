import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

// One COW relationship between an original doc and the per-draft clone we
// write to. `clonedAt`/`mergedAt` capture the fork and join points on the
// original — together they describe what the draft contributed to that doc.
export type CloneEntry = {
  cloneUrl: AutomergeUrl;
  clonedAt: UrlHeads;
  mergedAt?: UrlHeads;
};

// `parent` points at the URL this draft branches off of: the main draft (for
// top-level drafts, listed in `mainDraft.drafts`) or another `DraftDoc` (for
// sub-drafts attached via `DraftDoc.drafts`).
//
// `isMain` marks the single "main draft" a host doc points at via
// `@patchwork.mainDraftUrl`. The main draft is bookkeeping only: it is never
// resolved through (the overlay stays a no-op for main), its `clones` are
// identity mappings (`cloneUrl === url`, `clonedAt === []`), and its `drafts`
// holds the user-visible top-level draft list.
//
// `mergedAt` is a wall-clock timestamp set when the draft is merged into
// its parent; absent means "still open". The sidebar uses it to filter
// merged drafts out of the list.
export type DraftDoc = {
  "@patchwork": { type: "draft" };
  isMain?: boolean;
  parent: AutomergeUrl;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
  mergedAt?: number;
};

// A frozen, read-only view of a draft (or main) at a point in its history.
// `anchor` is the timeline entry the user clicked: it drives the row highlight
// and is the timestamp the other docs' heads are resolved against. `heads` maps
// each member doc's original url to the heads to view it at — exact for the
// anchor doc, latest-change-before-`anchor.time` for the rest. Docs with no
// change at or before that time are omitted (they didn't exist yet), so they
// fall through to their live state.
export type DraftCheckpoint = {
  anchor: { docUrl: AutomergeUrl; hash: string; time: number };
  heads: Record<AutomergeUrl, UrlHeads>;
};

// Ephemeral, writeable state owned by the draft-list provider and handed to
// the sidebar via `draft:checked-out`. It holds the selection: which draft is
// currently checked out. `checkedOut = null` means "main" — i.e. the host doc
// itself, no draft overlay. The derived drafts list lives separately in the
// read-only `draft:list` push (`DraftList`).
//
// `at` pins the checkout to a history entry: absent/null means the live latest
// heads (the default), set means a frozen read-only view (see DraftCheckpoint).
export type CheckedOutDraft = {
  checkedOut: AutomergeUrl | null;
  at?: DraftCheckpoint | null;
};

// Response shape for `draft:baseline { url }`. The draft overlay
// publishes `heads` as the document's fork-point heads (`clones[url].clonedAt`)
// once the doc has been cloned in this draft; consumers compute a diff
// against the live doc state from there. `heads` is `null` while there is no
// baseline yet (e.g. the doc hasn't been resolved in this draft, or "main" is
// selected). It is `null` rather than optional so the value is a valid
// structured-cloneable `JSONValue` crossing the provider channel.
export type Baseline = {
  heads: UrlHeads | null;
};

// One document that makes up a draft (or main), nested inside `DraftSummary`.
//
// On a draft these are the docs the overlay has forked — `cloneUrl` is the
// per-draft clone and `clonedAt` its fork point (mirrors `CloneEntry`). On
// "main" they come from the main draft's identity clones (`cloneUrl === url`,
// `clonedAt === []`) once it exists; before the first draft is created there is
// no main draft, so membership is observed from `patchwork:mounted` events and
// both fields are `null`. Like `Baseline`, the nullable fields use `null`
// rather than optional so the value stays a valid structured-cloneable
// `JSONValue` crossing the provider channel.
export type DraftMemberDoc = {
  url: AutomergeUrl;
  cloneUrl: AutomergeUrl | null;
  clonedAt: UrlHeads | null;
};

// One entry in the read-only `draft:list` push: a draft (or main) together
// with the member docs that make it up, so a consumer can render a card and
// its change timeline without loading the `DraftDoc` itself.
export type DraftSummary = {
  // The `DraftDoc` url for a real draft; the host/main-draft url for `main`.
  url: AutomergeUrl;
  members: DraftMemberDoc[];
  // Number of sub-drafts (`DraftDoc.drafts.length`), shown in the card meta.
  childCount: number;
};

// Response shape for `draft:list`: the host doc's `main` entry plus the flat,
// tree-ordered list of its (non-merged) drafts. Read-only and recomputed by
// the provider; selection lives separately in `CheckedOutDraft`.
export type DraftList = {
  main: DraftSummary;
  drafts: DraftSummary[];
};

// Convention: a document that has been drafted carries `@patchwork.mainDraftUrl`
// pointing at its single "main draft" — a `DraftDoc` (with `isMain`) whose
// `drafts` lists the top-level drafts that branch off of it. The pointer is
// created lazily on the first draft, so it is absent until then.
export type HasDrafts = {
  "@patchwork"?: {
    type?: string;
    mainDraftUrl?: AutomergeUrl;
  };
};

export function isDraftDoc(value: unknown): value is DraftDoc {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const marker = v["@patchwork"] as { type?: string } | undefined;
  return marker?.type === "draft" && !!v.clones && typeof v.clones === "object";
}
