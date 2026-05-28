import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

export type CloneEntry = {
  cloneUrl: AutomergeUrl;
  clonedAt: UrlHeads;
};

export type DraftDoc = {
  "@patchwork": { type: "draft" };
  parentDraftUrl: AutomergeUrl | null;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
};

// Ephemeral state owned by the draft-root provider; consumers mutate
// `selectedDraft` to switch drafts.
export type DraftsState = {
  drafts: AutomergeUrl[];
  selectedDraft: AutomergeUrl;
};

// Convention: any document may carry `@patchwork.draftUrl` pointing to the
// root `DraftDoc` of its draft tree. Absence means the document has no
// drafts; the field is created lazily on the first "New draft" action.
export type HasDraftMarker = {
  "@patchwork"?: {
    type?: string;
    draftUrl?: AutomergeUrl;
    [key: string]: unknown;
  };
};

export function isDraftDoc(value: unknown): value is DraftDoc {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const marker = v["@patchwork"] as { type?: string } | undefined;
  return marker?.type === "draft" && !!v.clones && typeof v.clones === "object";
}
