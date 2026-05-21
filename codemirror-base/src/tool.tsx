import { CodeMirror } from "./lib/codemirror.tsx";

/** CodeMirror Extensions */
import { RangeSet, type Extension } from "@codemirror/state";
import { Decoration, WidgetType } from "@codemirror/view";
import { commentButtonGutter } from "./lib/comments/commentButtonGutter.ts";

/** Automerge */
import type { PatchworkToolProps } from "./types.ts";
import {
  cursor,
  parseAutomergeUrl,
  refFromUrl,
  type DocHandle,
  type Ref,
  type RefUrl,
} from "@automerge/automerge-repo";

/** Patchwork */
import { getRegistry } from "@inkandswitch/patchwork-plugins";
import { annotations as globalAnnotations } from "@inkandswitch/annotations-context";
import { Diff } from "@inkandswitch/annotations-diff";
import { createComment } from "@inkandswitch/patchwork-comments";
import { request } from "@inkandswitch/patchwork-providers-solid";

/** Styles */
import { createSignal, onMount } from "solid-js";
import { useSubscribe } from "@inkandswitch/subscribables-solid";

export type TextDoc = {
  content: string;
};

const PATH = ["content"];
const VERSION = "v2.0.8";

export function CodeMirrorEditor(props: PatchworkToolProps<TextDoc>) {
  const contentRef = () => (props.handle as DocHandle<TextDoc>).ref(...PATH);

  const isReadOnly = () => !!parseAutomergeUrl(props.handle.url).heads;

  // TODO: what if contentRef() is undefined?

  const contentAnnotations = globalAnnotations.onChildrenOf(contentRef());
  const diffAnnotations = useSubscribe(contentAnnotations.ofType(Diff));

  // todo: once we have proper subdoc handle support comments should be just {targetRef: RefUrl, threadRef: RefUrl}[]
  const [allComments] = request<{
    comments: { targetRef: RefUrl; threadRef: RefUrl }[];
  }>(props.element, "patchwork:comments");

  const commentTargetRefs = (): Ref[] => {
    const entries = allComments()?.comments;
    if (!entries) return [];
    const seen = new Set<RefUrl>();
    const refs: Ref[] = [];
    for (const { targetRef } of entries) {
      if (!targetRef.startsWith(props.handle.url)) continue;
      if (seen.has(targetRef)) continue;
      seen.add(targetRef);
      try {
        refs.push(refFromUrl(props.handle, targetRef));
      } catch (error) {
        console.warn(
          `[codemirror-base] could not resolve ref ${targetRef}`,
          error
        );
      }
    }
    return refs;
  };

  // compute decorations
  const decorations = () =>
    RangeSet.of<Decoration>(
      [
        // decorations for diffs
        ...Array.from(diffAnnotations()).flatMap(([ref, diff]) => {
          const [start, end] = ref.rangePositions!;

          if (diff.value.type === "deleted") {
            return Decoration.widget({
              widget: new DeletionMarker(diff.value.before as string, false),
              side: 1,
            }).range(start);
          }

          // Skip zero-length ranges for non-deletion diffs
          if (start === end) return [];

          if (diff.value.type === "added") {
            const isDarkMode = window.matchMedia(
              "(prefers-color-scheme: dark)"
            ).matches;
            return Decoration.mark({
              attributes: {
                style: `
                border-bottom: 2px solid ${isDarkMode ? "#4ade80" : "#22c55e"};
                background-color: ${isDarkMode ? "#14532d" : "#dcfce7"};
              `,
              },
            }).range(start, end);
          }

          return [];
        }),
        // decorations for comments
        ...commentTargetRefs().flatMap((ref) => {
          const positions = ref.rangePositions;
          if (!positions) return [];
          const [start, end] = positions;
          if (start === end) return [];
          const isDarkMode = window.matchMedia(
            "(prefers-color-scheme: dark)"
          ).matches;
          return Decoration.mark({
            attributes: {
              style: `
                  border-bottom: 2px solid ${isDarkMode ? "#34d399" : "#10b981"};
                  background-color: ${isDarkMode ? "#064e3b" : "#d1fae5"};
                `,
            },
          }).range(start, end);
        }),
      ],
      true // sort ranges
    );

  // todo: better way to get the contactUrl of the current account
  const onComment = async (from: number, to: number) => {
    const accountDoc = (
      window as unknown as { accountDocHandle?: DocHandle<unknown> }
    ).accountDocHandle?.doc?.() as { contactUrl?: string } | undefined;
    const contactUrl = accountDoc?.contactUrl;
    if (!contactUrl) {
      console.warn("Cannot create comment: no contactUrl available", {
        accountDoc,
      });
      return;
    }
    const targetRef = props.handle.ref(...PATH, cursor(from, to));
    createComment({
      refs: [
        targetRef as unknown as Parameters<
          typeof createComment
        >[0]["refs"][number],
      ],
      content: "",
      contactUrl,
    });
  };

  // Base CodeMirror extensions (context-specific, not language-specific)
  const [extensions, setExtensions] = createSignal<Extension[]>([
    commentButtonGutter(onComment),
  ]);

  // Load CodeMirror extensions dynamically on mount
  onMount(async () => {
    // Get document type from handle
    const docType = (props.handle.doc() as any)?.["@patchwork"]?.type;

    // Load extensions that support this document type
    const extensionsRegistry = getRegistry<any>("codemirror:extension");

    const loadedExtensions = await extensionsRegistry.loadAll(
      extensionsRegistry.filter((ext) => {
        return (
          ext.supportedDatatypes === "*" ||
          (Array.isArray(ext.supportedDatatypes) &&
            ext.supportedDatatypes.includes(docType))
        );
      })
    );

    // Flatten and add to existing extensions
    const flattenedExts = loadedExtensions.flatMap((ext) => {
      const impl = ext.module;
      return Array.isArray(impl) ? impl : [impl];
    });

    setExtensions((exts) => [...exts, ...flattenedExts]);
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
              readOnly={isReadOnly()}
            />
          </div>
        </div>
      </div>
    </div>
  );
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

    // Add dark mode styles
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
