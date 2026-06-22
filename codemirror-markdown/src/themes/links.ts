import { EditorView } from "@codemirror/view";

export const linkTheme = EditorView.baseTheme({
  ".cm-link": {
    textDecoration: "underline",
    cursor: "pointer",
    fontFamily: '"Merriweather Sans", sans-serif',
    color: "var(--syntax-link, #0066cc)",
    "&:hover": {
      color: "inherit",
    },
  },
});
