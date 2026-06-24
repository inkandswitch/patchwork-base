import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

// One COW relationship between an original doc and the per-draft clone we
// write to. `clonedAt`/`mergedAt` capture the fork and join points on the
// original — together they describe what the draft contributed to that doc.
export type CloneEntry = {
  cloneUrl: AutomergeUrl;
  clonedAt: UrlHeads;
  mergedAt?: UrlHeads;
};

// `parent` points at the URL this draft branches off of: either the host
// document (for top-level drafts attached via `@patchwork.drafts`) or
// another `DraftDoc` (for sub-drafts attached via `DraftDoc.drafts`).
//
// `mergedAt` is a wall-clock timestamp set when the draft is merged into
// its parent; absent means "still open". The sidebar uses it to filter
// merged drafts out of the list.
export type DraftDoc = {
  "@patchwork": { type: "draft" };
  parent: AutomergeUrl;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
  mergedAt?: number;
};

// Ephemeral state owned by the draft-list provider. `selectedDraft = null`
// means "main" — i.e. the host doc itself, no draft overlay.
export type DraftsState = {
  drafts: AutomergeUrl[];
  selectedDraft: AutomergeUrl | null;
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

// Response shape for `draft:member-docs`: one entry per document that makes up
// the current view, streamed by the draft-list provider.
//
// On a draft these are the docs the overlay has forked — `cloneUrl` is the
// per-draft clone and `clonedAt` its fork point (mirrors `CloneEntry`). On
// "main" there is no clone, so both are `null` and membership is observed via
// `patchwork:mounted` events instead. Like `Baseline`, the nullable fields use
// `null` rather than optional so the value stays a valid structured-cloneable
// `JSONValue` crossing the provider channel.
export type DraftMemberDoc = {
  url: AutomergeUrl;
  cloneUrl: AutomergeUrl | null;
  clonedAt: UrlHeads | null;
};

// Convention: any document may carry `@patchwork.drafts` listing the
// top-level drafts that branch off of it. Each entry is the URL of a
// `DraftDoc`, which in turn may have its own sub-drafts via `DraftDoc.drafts`.
export type HasDrafts = {
  "@patchwork"?: {
    type?: string;
    drafts?: AutomergeUrl[];
  };
};

export function isDraftDoc(value: unknown): value is DraftDoc {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const marker = v["@patchwork"] as { type?: string } | undefined;
  return marker?.type === "draft" && !!v.clones && typeof v.clones === "object";
}
