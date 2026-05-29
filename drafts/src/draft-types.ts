import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

export type CloneEntry = {
  cloneUrl: AutomergeUrl;
  clonedAt: UrlHeads;
};

// `parent` points at the URL this draft branches off of: either the host
// document (for top-level drafts attached via `@patchwork.drafts`) or
// another `DraftDoc` (for sub-drafts attached via `DraftDoc.drafts`).
export type DraftDoc = {
  "@patchwork": { type: "draft" };
  parent: AutomergeUrl;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
};

// Ephemeral state owned by the draft-list provider. `selectedDraft = null`
// means "main" — i.e. the host doc itself, no draft overlay.
export type DraftsState = {
  drafts: AutomergeUrl[];
  selectedDraft: AutomergeUrl | null;
};

// Response shape for `patchwork:baseline { url }`. The draft overlay
// publishes `heads` as the document's fork-point heads (`clones[url].clonedAt`)
// once the doc has been COW'd in this draft; consumers compute a diff
// against the live doc state from there. `heads` is undefined while there
// is no baseline yet (e.g. the doc hasn't been written to in this draft).
export type Baseline = {
  heads?: UrlHeads;
};

// Convention: any document may carry `@patchwork.drafts` listing the
// top-level drafts that branch off of it. Each entry is the URL of a
// `DraftDoc`, which in turn may have its own sub-drafts via `DraftDoc.drafts`.
export type HasDrafts = {
  "@patchwork"?: {
    drafts?: AutomergeUrl[];
  };
};

export function isDraftDoc(value: unknown): value is DraftDoc {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const marker = v["@patchwork"] as { type?: string } | undefined;
  return marker?.type === "draft" && !!v.clones && typeof v.clones === "object";
}
