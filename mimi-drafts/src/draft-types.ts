import type { AutomergeUrl, UrlHeads } from "@automerge/automerge-repo";

// Links one real document to the private copy a draft edits instead.
// When you edit a doc inside a draft, we don't touch the real doc — we make a
// copy ("clone") and edit that. This records the pairing:
//   - cloneUrl:  where the draft's private copy lives
//   - clonedAt:  the point in the real doc's history where the copy split off
//   - mergedAt:  the point where the copy was later merged back (if it was)
// Together, clonedAt..mergedAt describe exactly what this draft changed.
export type CloneEntry = {
  cloneUrl: AutomergeUrl;
  clonedAt: UrlHeads;
  mergedAt?: UrlHeads;
};

// A draft: a named set of private edits branched off the real document.
//
//   - parent:   what this draft branched off of. For a normal draft that's the
//               "main draft" (see isMain); for a sub-draft it's another draft.
//   - drafts:   the drafts that branch off THIS one (a draft can have children).
//   - clones:   the private copies this draft edits, one per real document it
//               has touched (see CloneEntry).
//   - isMain:   marks the one special "main draft". Every drafted document has
//               exactly one. It does no editing of its own — it's just a record
//               keeper: its `drafts` list is the set of real drafts you see in
//               the sidebar, and its `clones` just point each doc at itself.
//   - mergedAt: the time this draft was merged back into its parent. Missing
//               means the draft is still open; the sidebar hides merged ones.
export type DraftDoc = {
  "@patchwork": { type: "draft" };
  isMain?: boolean;
  parent: AutomergeUrl;
  drafts: AutomergeUrl[];
  clones: Record<AutomergeUrl, CloneEntry>;
  mergedAt?: number;
  // An optional user-given name shown on the draft's card. Missing means the
  // card falls back to the generic "Draft" label.
  name?: string;
};

// How to show one document inside a frozen "this is how it looked back then"
// snapshot.
//   - to:   the past version to display (read-only). Leave it out to show the
//           current, live version.
//   - from: the older version to compare against, so we can highlight what
//           changed. Leave it out for no comparison. If the version we're
//           showing is the doc's very first one, there's nothing before it, so
//           `from` is empty `[]` and the whole doc shows as newly added.
// ("heads" is Automerge's way of naming an exact point in a doc's history.)
export type DocCheckpoint = {
  from?: UrlHeads;
  to?: UrlHeads;
};

// A complete "time machine" snapshot of a draft (or of Main): for every
// document in it, which past version to show and compare against (see
// DocCheckpoint). Keyed by each document's real url.
//
// Built when you click a row in the change history: the doc you clicked is
// shown at exactly that change; every other doc is shown at its most recent
// change from around the same time (close enough). Docs that didn't exist yet
// at that time are left out, so they just show their live version.
export type DraftCheckpoint = Record<AutomergeUrl, DocCheckpoint>;

// Tracks what you're currently looking at. This is a small, throwaway document
// (not saved long-term) that the sidebar reads and writes.
//   - checkedOut: which draft you have open. `null` means you're on "Main" —
//                 the real document, with no draft edits layered on top.
//   - at:         if you've clicked into history, the frozen snapshot you're
//                 viewing (see DraftCheckpoint). Empty/null means you're on the
//                 latest, live version (the normal case).
// The actual list of drafts is computed separately and delivered as DraftList.
export type CheckedOutDraft = {
  checkedOut: AutomergeUrl | null;
  at?: DraftCheckpoint | null;
};

// The answer to "what version should I compare this document against to show
// what the draft changed?" `heads` is that comparison point:
//   - if you're viewing a history snapshot, it's that snapshot's "from" version;
//   - otherwise, in a live draft, it's the point where the draft's copy split
//     off the real doc (so the diff shows everything the draft has done since).
//   - `null` means there's nothing to compare against (e.g. on Main with no
//     snapshot, or before the draft has copied this doc).
// It's `null` rather than simply omitted so it can be safely sent across the
// channel between the provider and the sidebar.
export type Baseline = {
  heads: UrlHeads | null;
};

// One of the documents that make up a draft (or Main), as listed in a
// DraftSummary.
//   - url:      the real document.
//   - cloneUrl: the draft's private copy of it, if one exists yet.
//   - clonedAt: where that copy split off (see CloneEntry).
// In a draft, cloneUrl/clonedAt describe the private copy. On Main there are no
// private copies, so cloneUrl just points back to the doc itself; and before
// you've ever drafted this document, we don't even know those yet, so both are
// `null`. (As with Baseline, we use `null` instead of omitting them so the
// value can be sent across the provider/sidebar channel.)
export type DraftMemberDoc = {
  url: AutomergeUrl;
  cloneUrl: AutomergeUrl | null;
  clonedAt: UrlHeads | null;
};

// Everything the sidebar needs to draw one card (a draft, or Main) and its
// change history, without having to load the draft document itself.
export type DraftSummary = {
  // The draft's url (or, for Main, the real document's url).
  url: AutomergeUrl;
  // The documents that make up this draft/Main.
  members: DraftMemberDoc[];
  // How many sub-drafts branch off this one, shown on the card.
  childCount: number;
  // The draft's user-given name, if it has one (see DraftDoc.name). Undefined
  // for Main and for unnamed drafts.
  name?: string;
};

// The whole list shown in the sidebar: the Main entry plus all the open
// (not-yet-merged) drafts. Recomputed by the provider whenever things change;
// what you currently have open is tracked separately in CheckedOutDraft.
export type DraftList = {
  main: DraftSummary;
  drafts: DraftSummary[];
};

// Any document that has been drafted gets a pointer (`mainDraftUrl`) to its
// "main draft" — the bookkeeping record that lists all its drafts (see
// DraftDoc's isMain). This pointer is only added the first time you create a
// draft on the document, so it's missing until then.
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
