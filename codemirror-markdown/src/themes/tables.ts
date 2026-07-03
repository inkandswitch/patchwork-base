import { EditorView } from "@codemirror/view";

export const tableTheme = EditorView.baseTheme({
  ".cm-md-table-wrapper": {
    margin: "1rem 0",
    overflowX: "auto",
    cursor: "text",
  },
  ".cm-md-table": {
    borderCollapse: "collapse",
    width: "auto",
    maxWidth: "100%",
    fontFamily: '"Merriweather Sans", sans-serif',
    fontSize: "0.95em",
    lineHeight: "1.4",
  },
  ".cm-md-table th, .cm-md-table td": {
    border: "1px solid var(--syntax-table-border, rgba(0, 0, 0, 0.15))",
    padding: "0.35em 0.75em",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-md-table th": {
    fontWeight: 600,
    background: "var(--syntax-table-header-fill, rgba(0, 0, 0, 0.04))",
  },
  ".cm-md-table tbody tr:nth-child(even)": {
    background: "var(--syntax-table-row-fill, rgba(0, 0, 0, 0.02))",
  },
});
