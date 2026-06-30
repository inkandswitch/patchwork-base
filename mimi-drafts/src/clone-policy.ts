import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";

// Kinds of document that drafts should NEVER copy, even though they pass
// through the draft.
//
// A draft normally copies every document you touch, so your edits stay private
// to the draft. But a few documents that get pulled in aren't really "part of
// the thing you're drafting" — they're app-wide: your account/settings (read by
// the sidebar, which lives inside the draft) and people's contact cards (looked
// up for each comment author). Copying those into a draft would fork global
// state like your settings or someone's profile — clearly wrong, and it could
// even get merged back into the real document.
//
// The same list is used elsewhere so the documents we *show* as part of a draft
// match the ones a draft would actually copy.
//
// This is admittedly a blunt tool: the cleaner fix is to actually know which
// documents belong to a draft and copy only those, rather than excluding a few
// by name. Until then we keep this skip-list, matched against each document's
// declared type (`@patchwork.type`).
export const SKIPPED_DATATYPES: ReadonlySet<string> = new Set([
  "account",
  "contact",
  "draft",
]);

// Strip a document url down to just "which document" — dropping any extra bits
// like a specific version or path. That way the same document always produces
// the same url, no matter how we arrived at it, so we can match and de-duplicate
// reliably.
export function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}
