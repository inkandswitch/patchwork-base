import { CodeMirror } from "./lib/codemirror.tsx";

/** CodeMirror Extensions */
import { RangeSet, type Extension, type Range } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { commentButtonGutter } from "./lib/comments/commentButtonGutter.ts";

/** Automerge */
import type { PatchworkToolProps } from "./types.ts";
import {
  cursor,
  type AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo";

/** Patchwork */
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { annotations as globalAnnotations } from "@inkandswitch/annotations-context";
import type { Annotation } from "@inkandswitch/annotations";
import { Diff } from "@inkandswitch/annotations-diff";
import { createComment } from "@inkandswitch/patchwork-comments";
import {
  subscribeDoc,
  subscribe,
} from "@inkandswitch/patchwork-providers-solid";

/** Styles */
import { createResource, createSignal, onMount } from "solid-js";
import { useSubscribe } from "@inkandswitch/subscribables-solid";

export type TextDoc = {
  content: string;
};

const PATH = ["content"];
const VERSION = "v2.0.25-comments";

export function CodeMirrorEditor(props: PatchworkToolProps<TextDoc>) {
  const contentRef = () => (props.handle as DocHandle<TextDoc>).sub(...PATH);

  const isReadOnly = props.handle.isReadOnly();

  // TODO: what if contentRef() is undefined?

  const contentAnnotations = globalAnnotations.onChildrenOf(contentRef());
  const diffAnnotations = useSubscribe(contentAnnotations.ofType(Diff));

  const commentEntries = subscribe<
    { targetRef: AutomergeUrl; threadRef: AutomergeUrl }[]
  >(props.element, { type: "patchwork:comments" }, []);

  // We own `selection` (cursor) and only read `highlight` (other views'
  // emphasis). Splitting the two avoids any feedback loop.
  const [focusDoc, focusHandle] = subscribeDoc<{
    selection: Record<AutomergeUrl, true>;
    highlight: Record<AutomergeUrl, true>;
  }>(props.element, { type: "patchwork:focus" });

  const contactUrl = subscribe<AutomergeUrl>(props.element, {
    type: "patchwork:contact",
  });

  // `getDedupedCommentTargets` resolves refs asynchronously, so drive it
  // through a resource keyed on the comment entries.
  const [commentTargets] = createResource(
    commentEntries,
    (entries) =>
      getDedupedCommentTargets(entries, props.handle.url, props.repo),
    { initialValue: [] }
  );

  // `resolveRefsInDoc` resolves refs asynchronously, so drive it through a
  // resource keyed on the focus doc. Emphasis is selection ∪ highlight.
  const [emphasisTargets] = createResource(
    () => focusDoc(),
    async (doc) => {
      const [selection, highlight] = await Promise.all([
        resolveRefsInDoc(doc?.selection, props.handle.url, props.repo),
        resolveRefsInDoc(doc?.highlight, props.handle.url, props.repo),
      ]);
      return Array.from(new Set([...selection, ...highlight]));
    },
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
      [
        ...buildDiffDecorations(diffAnnotations(), dark),
        ...buildCommentDecorations(targetRefs, emphasisRefs, dark),
      ],
      true // sort ranges
    );
  };

  const onComment = (from: number, to: number) => {
    const url = contactUrl();
    if (!url) {
      console.warn("Cannot create comment: no contactUrl available");
      return;
    }
    void createCommentForRange(props.handle, PATH, from, to, url);
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
      <div
        class="absolute top-1 right-2 text-xs text-gray-400 font-medium pointer-events-none select-none z-10"
        title="Text Editor 2 version"
      >
        Text Editor {VERSION}
      </div>
      <div class="p-4 h-full">
        <div class="flex h-full">
          <div class="relative flex-1 h-full">
            <CodeMirror
              handle={props.handle as DocHandle<TextDoc>}
              path={PATH}
              decorations={decorations}
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

// The comments provider already scopes entries to this doc by `targetRef`,
// so this just dedupes and resolves each ref to a `Ref` on the handle.
async function getDedupedCommentTargets(
  comments: { targetRef: AutomergeUrl }[] | undefined,
  docUrl: AutomergeUrl,
  repo: Repo
): Promise<DocHandle<unknown>[]> {
  if (!comments) return [];
  const overlappingRefs = new Set<DocHandle<unknown>>();
  for (const comment of comments) {
    if (comment.targetRef.startsWith(docUrl)) {
      const target = await repo.find(comment.targetRef);
      overlappingRefs.add(target);
    }
  }
  return Array.from(overlappingRefs);
}

// Scopes a map of refs to this doc and resolves each one to a `DocHandle`.
// Used for both our own `selection` and other views' `highlight`.
async function resolveRefsInDoc(
  map: Record<AutomergeUrl, true> | undefined,
  docUrl: AutomergeUrl,
  repo: Repo
): Promise<DocHandle<unknown>[]> {
  if (!map) return [];
  const refs = new Set<DocHandle<unknown>>();
  for (const url of Object.keys(map) as AutomergeUrl[]) {
    if (url.startsWith(docUrl)) {
      refs.add(await repo.find(url));
    }
  }
  return Array.from(refs);
}

function buildDiffDecorations(
  diffs: Iterable<Annotation<unknown, Diff<unknown>>>,
  dark: boolean
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const [ref, diff] of diffs) {
    const [start, end] = ref.rangePositions!;
    if (diff.value.type === "deleted") {
      out.push(
        Decoration.widget({
          widget: new DeletionMarker(diff.value.before as string, false),
          side: 1,
        }).range(start)
      );
      continue;
    }
    // Skip zero-length ranges for non-deletion diffs.
    if (start === end) continue;
    if (diff.value.type === "added") {
      out.push(
        Decoration.mark({
          attributes: { style: addedDiffStyle(dark) },
        }).range(start, end)
      );
    }
  }
  return out;
}

function addedDiffStyle(dark: boolean): string {
  return `
    border-bottom: 2px solid ${dark ? "#4ade80" : "#22c55e"};
    background-color: ${dark ? "#14532d" : "#dcfce7"};
  `;
}

class DeletionMarker extends WidgetType {
  deletedText: string;
  isActive: boolean;

  constructor(deletedText: string, isActive: boolean) {
    super();
    this.deletedText = deletedText;
    this.isActive = isActive;
  }

  toDOM(): HTMLElement {
    const box = document.createElement("div");
    box.style.display = "inline-block";
    box.style.boxSizing = "border-box";
    box.style.padding = "0 2px";
    box.style.color = "rgb(239 68 68)"; // red-500
    box.style.margin = "0 4px";
    box.style.fontSize = "0.8em";
    box.style.backgroundColor = this.isActive
      ? "rgb(239 68 68 / 20%)" // red-500 with opacity
      : "rgb(239 68 68 / 10%)";
    box.style.borderRadius = "3px";
    box.style.cursor = "default";
    box.innerText = "⌫";

    const hoverText = document.createElement("div");
    hoverText.style.position = "absolute";
    hoverText.style.zIndex = "1";
    hoverText.style.padding = "5px";
    hoverText.style.backgroundColor = "rgb(254 242 242)"; // red-50
    hoverText.style.fontSize = "15px";
    hoverText.style.color = "rgb(17 24 39)"; // gray-900
    hoverText.style.border = "1px solid rgb(185 28 28)"; // red-700
    hoverText.style.boxShadow = "0px 0px 6px rgba(0, 0, 0, 0.1)";
    hoverText.style.borderRadius = "3px";
    hoverText.style.visibility = "hidden";
    hoverText.innerText = this.deletedText;

    const isDarkMode =
      document.documentElement.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;

    if (isDarkMode) {
      box.style.color = "rgb(248 113 113)"; // red-400 for dark mode
      box.style.backgroundColor = this.isActive
        ? "rgb(248 113 113 / 20%)"
        : "rgb(248 113 113 / 10%)";
      hoverText.style.backgroundColor = "rgb(69 10 10)"; // red-950
      hoverText.style.color = "rgb(254 226 226)"; // red-100
      hoverText.style.border = "1px solid rgb(153 27 27)"; // red-800
    }

    box.appendChild(hoverText);

    box.onmouseover = function () {
      hoverText.style.visibility = "visible";
    };
    box.onmouseout = function () {
      hoverText.style.visibility = "hidden";
    };

    return box;
  }

  eq(other: DeletionMarker) {
    return (
      other.deletedText === this.deletedText && other.isActive === this.isActive
    );
  }

  ignoreEvent() {
    return true;
  }
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

async function createCommentForRange(
  handle: DocHandle<unknown>,
  path: readonly string[],
  from: number,
  to: number,
  contactUrl: AutomergeUrl
): Promise<void> {
  const targetRef = handle.sub(...path, cursor(from, to));
  await createComment({
    refs: [
      targetRef as unknown as Parameters<
        typeof createComment
      >[0]["refs"][number],
    ],
    content: "",
    contactUrl,
  });
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
