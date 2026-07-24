import {
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  type AutomergeUrl,
} from "@automerge/automerge-repo";

// HACK: datatypes the draft machinery must never treat as draft content.
//
// The overlay forks *every* document resolved beneath it so edits stay scoped
// to the draft. But some docs pulled through the overlay are app-global rather
// than part of the document being drafted: the account doc (read by the context
// sidebar, which renders inside the overlay) and contact docs (resolved per
// comment author). Forking those branches global state — account config, user
// profiles — into a draft, which is wrong and could even merge back into main.
//
// The same list filters the "main" branch of `draft:member-docs`, so the set
// of documents reported there matches the docs a draft would actually fork.
//
// The principled fix is to know which documents actually belong to the draft
// and fork only those — nothing should be treated as draft content just because
// it was resolved beneath the overlay. Until we have that notion of draft
// membership we invert the problem with a blunt skip-list: it bakes app-level
// datatype names into otherwise-generic machinery and relies on each doc
// carrying a matching `@patchwork.type`.
export const SKIPPED_DATATYPES: ReadonlySet<string> = new Set([
  "account",
  "contact",
  "draft",
  "change-group-cache",
]);

// Reduce a url to its bare document identity by stripping any path/heads
// suffix, so urls arriving from different traversals dedupe to the same key.
export function canonicalUrl(url: AutomergeUrl): AutomergeUrl {
  const { documentId } = parseAutomergeUrl(url);
  return stringifyAutomergeUrl({ documentId });
}
