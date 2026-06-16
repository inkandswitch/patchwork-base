import { CodeMirror } from "./lib/codemirror.tsx";

/** CodeMirror Extensions */
import { RangeSet, type Extension, type Range } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { commentButtonGutter } from "./lib/extensions/commentButtonGutter.ts";

/** Automerge */
import type { PatchworkToolProps } from "./types.ts";
import {
  cursor,
  type AutomergeUrl,
  DocHandle,
  Repo,
  type UrlHeads,
} from "@automerge/automerge-repo";

/** Patchwork */
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import {
  subscribeDoc,
  subscribe,
} from "@inkandswitch/patchwork-providers-solid";

/** Styles */
import { createMemo, createResource, createSignal, onMount } from "solid-js";
import { createCommentForRange } from "./lib/extensions/comments.ts";

export type TextDoc = {
  content: string;
};

type CommentEntry = {
  targetUrl: AutomergeUrl;
};

// Diff baseline served by the draft overlay (`patchwork:baseline`). `heads` is
// `null` when there is no baseline yet (e.g. the doc hasn't been COW'd in the
// active draft, or "main" is selected), in which case no diff is rendered.
type Baseline = { heads: UrlHeads | null };

const PATH = ["content"];

export function CodeMirrorEditor(props: PatchworkToolProps<TextDoc>) {
  const isReadOnly = props.handle.isReadOnly();

  // Diff baseline from the active draft overlay; plain JSON `{ heads }`. Fed to
  // the CodeMirror diff extension, which recomputes spans on every doc change
  // (driven by the sync plugin's transactions, so no manual tick is needed).
  const baseline = subscribe<Baseline>(
    props.element,
    { type: "patchwork:baseline", url: props.handle.url },
    { heads: null }
  );

  const commentEntries = subscribe<CommentEntry[]>(
    props.element,
    { type: "patchwork:comments" },
    []
  );

  const [focusDoc, focusHandle] = subscribeDoc<{
    selection: Record<AutomergeUrl, true>;
    highlight: Record<AutomergeUrl, true>;
  }>(props.element, { type: "patchwork:focus" });

  const contactUrl = subscribe<AutomergeUrl>(props.element, {
    type: "patchwork:contact",
  });

  const [commentTargets] = createResource(
    commentEntries,
    (entries) =>
      getDedupedCommentTargets(entries, props.handle.url, props.repo),
    { initialValue: [] }
  );

  // CommentsView writes selected comment targets into `selection`/`highlight`.
  // Read those URL keys directly so this memo updates when the maps change;
  // using `focusDoc()` itself doesn't trigger a change when the selection and highlight array inside of it change
  const focusRefUrls = createMemo(() => {
    const doc = focusDoc();
    return [
      ...Object.keys(doc?.selection ?? {}),
      ...Object.keys(doc?.highlight ?? {}),
    ] as AutomergeUrl[];
  });

  const [emphasisTargets] = createResource(
    focusRefUrls,
    async (urls) => resolveSubDocUrlsOfDoc(urls, props.handle.url, props.repo),
    { initialValue: [] }
  );

  let lastEmittedUrl: AutomergeUrl | undefined;

  const onChangeSelection = (from: number, to: number) => {
    const handle = focusHandle();
    if (!handle) return;
    const nextUrl = props.handle.sub(...PATH, cursor(from, to)).url;
    if (nextUrl === lastEmittedUrl) return;
    handle.change((doc) => {
      doc.selection = { [nextUrl]: true };
    });
    lastEmittedUrl = nextUrl;
  };

  const decorations = () => {
    const dark = prefersDarkMode();
    const targetRefs = commentTargets();
    const emphasisRefs = emphasisTargets();
    return RangeSet.of<Decoration>(
      buildCommentDecorations(targetRefs, emphasisRefs, dark),
      true // sort ranges
    );
  };

  const onComment = (from: number, to: number) => {
    const url = contactUrl();
    if (!url) {
      console.warn("Cannot create comment: no contactUrl available");
      return;
    }
    createCommentForRange(props.handle, PATH, from, to, url);
  };

  // Base CodeMirror extensions (context-specific, not language-specific)
  const [extensions, setExtensions] = createSignal<Extension[]>([
    commentButtonGutter(onComment),
  ]);

  onMount(async () => {
    const loaded = await loadCodeMirrorExtensionsForDoc(props.handle);
    setExtensions((exts) => [...exts, ...loaded]);
  });

  return (
    <div class="w-full h-full overflow-auto bg-base relative">
      <div class="p-4 h-full">
        <div class="flex h-full">
          <div class="relative flex-1 h-full">
            <CodeMirror
              handle={props.handle as DocHandle<TextDoc>}
              path={PATH}
              decorations={decorations}
              baseline={() => baseline()?.heads ?? null}
              extensions={extensions()}
              readOnly={isReadOnly}
              onChangeSelection={onChangeSelection}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function prefersDarkMode(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// The comments provider already scopes entries to this doc by `targetUrl`,
// so this just dedupes and resolves each url to a `DocHandle`.
async function getDedupedCommentTargets(
  comments: CommentEntry[] | undefined,
  docUrl: AutomergeUrl,
  repo: Repo
): Promise<DocHandle<unknown>[]> {
  if (!comments) return [];
  const overlappingRefs = new Set<DocHandle<unknown>>();
  for (const comment of comments) {
    if (comment.targetUrl.startsWith(docUrl)) {
      const target = await repo.find(comment.targetUrl);
      overlappingRefs.add(target);
    }
  }
  return Array.from(overlappingRefs);
}

// Scopes ref urls to this doc and resolves each one to a `DocHandle`.
// Used for both our own `selection` and other views' `highlight`.
async function resolveSubDocUrlsOfDoc(
  urls: AutomergeUrl[],
  docUrl: AutomergeUrl,
  repo: Repo
): Promise<DocHandle<unknown>[]> {
  const refs = new Set<DocHandle<unknown>>();
  for (const url of urls) {
    if (url.startsWith(docUrl)) {
      refs.add(await repo.find(url));
    }
  }
  return Array.from(refs);
}

// Targets that overlap `emphasisRefs` (selection ∪ highlight) render in
// darker yellow; the rest stay in light yellow.
function buildCommentDecorations(
  targetRefs: DocHandle<unknown>[],
  emphasisRefs: DocHandle<unknown>[],
  dark: boolean
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const ref of targetRefs) {
    const positions = ref.rangePositions();
    if (!positions) continue;
    const [start, end] = positions;
    if (start === end) continue;
    const isEmphasised = emphasisRefs.some((s) => s.overlaps(ref));
    out.push(
      Decoration.mark({
        attributes: { style: commentTargetStyle(isEmphasised, dark) },
      }).range(start, end)
    );
  }
  return out;
}

function commentTargetStyle(isEmphasised: boolean, dark: boolean): string {
  return isEmphasised
    ? `
        border-bottom: 2px solid ${dark ? "#facc15" : "#ca8a04"};
        background-color: ${dark ? "#a16207" : "#fde047"};
      `
    : `
        border-bottom: 2px solid ${dark ? "#ca8a04" : "#eab308"};
        background-color: ${dark ? "#713f12" : "#fef9c3"};
      `;
}

async function loadCodeMirrorExtensionsForDoc(
  handle: DocHandle<unknown>
): Promise<Extension[]> {
  const docType = (handle.doc() as any)?.["@patchwork"]?.type;
  const registry = getRegistry<any>("codemirror:extension");
  const loaded = await registry.loadAll(
    registry.filter((ext) => {
      return (
        ext.supportedDatatypes === "*" ||
        (Array.isArray(ext.supportedDatatypes) &&
          ext.supportedDatatypes.includes(docType))
      );
    })
  );
  return loaded.flatMap((ext) => {
    const impl = ext.module;
    return Array.isArray(impl) ? impl : [impl];
  });
}
