/** CodeMirror Extensions */
import { completionKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { searchKeymap } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";

/** Styles */
import { theme } from "../themes/markdown.ts";
import { tablePreview } from "./tables.ts";

export function markdownExtensions() {
  return [
    ...theme("sans"),
    history(),
    indentOnInput(),
    keymap.of([
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.lineWrapping,
    markdown({ codeLanguages: languages, extensions: GFM }),
    ...tablePreview(),
    indentUnit.of("    "),
  ];
}
