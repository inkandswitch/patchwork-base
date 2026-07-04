import { Extension, StateField } from "@codemirror/state";
import { EditorView, showTooltip, Tooltip } from "@codemirror/view";

type CommentButtonCallback = (
  from: number,
  to: number,
  view: EditorView
) => void;

// A speech-bubble icon + "Comment" label, shown floating above the selection.
const buildCommentButton = (
  from: number,
  to: number,
  view: EditorView,
  onComment: CommentButtonCallback
): HTMLElement => {
  const button = document.createElement("button");
  button.className = "cm-comment-button";
  button.setAttribute("aria-label", "Comment");

  button.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
         xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
            fill="currentColor" stroke="none"/>
    </svg>
    <span>Comment</span>
  `;

  // Without this, the browser focuses the button on mousedown, the editor
  // blurs, the selection collapses, our tooltip source returns null, and
  // CodeMirror tears down the button before `click` fires — so the first
  // press silently does nothing and the user has to click twice. Swallowing
  // mousedown keeps the editor focused and the selection (and button) alive
  // long enough for the click to land.
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onComment(from, to, view);
  });

  return button;
};

const commentTooltip = (
  state: EditorView["state"],
  onComment: CommentButtonCallback
): Tooltip | null => {
  const sel = state.selection.main;
  if (sel.empty) return null;

  // Anchor the button at the drag tail (the selection head) rather than the
  // start, so dragging left-to-right lands it on the right and right-to-left
  // on the left.
  return {
    pos: sel.head,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({
      dom: buildCommentButton(sel.from, sel.to, view, onComment),
    }),
  };
};

// Global colours are lifted into local --cm-comment-* tokens in a
// :root/:host/[theme] block so they re-evaluate when the theme swaps. This
// derivation can't live in the baseTheme below — CodeMirror prefixes every
// non-"&" selector with the editor's scope class, so a `:root` key would
// become `.cm... :root` and never match. It's injected as a plain stylesheet
// instead, and the button reads only the derived tokens. The button is editor
// UI, so it derives from --editor-* (not --studio-*, which is studio chrome).
const COMMENT_BUTTON_VARS_ID = "cm-comment-button-vars";
const ensureCommentButtonVars = (): void => {
  if (
    typeof document === "undefined" ||
    document.getElementById(COMMENT_BUTTON_VARS_ID)
  ) {
    return;
  }
  const style = document.createElement("style");
  style.id = COMMENT_BUTTON_VARS_ID;
  style.textContent = `
    :root, :host, [theme] {
      /* the button is a primary surface: bg is the accent fill, text is its
         invert (ink legible ON the accent), hover lifts one step up the accent
         ramp. see --studio-primary-* in the theme. */
      --cm-comment-button-fg: var(--studio-primary-line, #0a2b23);
      --cm-comment-button-bg: var(--studio-primary-fill, #35f7ca);
      --cm-comment-button-bg-hover: var(--studio-primary-fill-offset-20, #2ce0b6);
    }
  `;
  document.head.append(style);
};

const commentButtonTheme = EditorView.baseTheme({
  ".cm-tooltip:has(.cm-comment-button)": {
    border: "none",
    background: "transparent",
    boxShadow: "none",
  },
  ".cm-comment-button": {
    display: "inline-flex",
    alignItems: "center",
    gap: "5px",
    padding: "4px 9px",
    font: "inherit",
    fontSize: "12px",
    fontWeight: "500",
    lineHeight: "1",
    color: "var(--cm-comment-button-fg)",
    background: "var(--cm-comment-button-bg)",
    border: "none",
    borderRadius: "6px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    transition: "background-color 0.15s",
  },
  ".cm-comment-button:hover": {
    background: "var(--cm-comment-button-bg-hover)",
  },
  ".cm-comment-button svg": {
    display: "block",
  },
});

// Factory function to create the floating comment button with a callback.
export const commentButtonGutter = (
  onComment: CommentButtonCallback
): Extension => {
  ensureCommentButtonVars();

  const field = StateField.define<Tooltip | null>({
    create: (state) => commentTooltip(state, onComment),
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value;
      return commentTooltip(tr.state, onComment);
    },
    provide: (f) => showTooltip.from(f),
  });

  return [field, commentButtonTheme];
};
