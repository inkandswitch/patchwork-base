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
    color: "var(--studio-fill, white)",
    background: "var(--studio-line, #3b3b3b)",
    border: "none",
    borderRadius: "6px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
    transition: "background-color 0.15s",
  },
  ".cm-comment-button:hover": {
    background: "var(--studio-line-offset-10, #555)",
  },
  ".cm-comment-button svg": {
    display: "block",
  },
});

// Factory function to create the floating comment button with a callback.
export const commentButtonGutter = (
  onComment: CommentButtonCallback
): Extension => {
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
