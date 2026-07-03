import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { tableTheme } from "../themes/tables.ts";

type Align = "left" | "center" | "right" | null;

interface ParsedTable {
  header: string[];
  aligns: Align[];
  rows: string[][];
}

/**
 * Split a single GFM table row into its cells, honouring `\|` escapes and
 * backtick code spans (which may legally contain a literal `|`).
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);

  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(spec: string): Align {
  const s = spec.trim();
  const left = s.startsWith(":");
  const right = s.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function parseTable(src: string): ParsedTable | null {
  const lines = src.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const header = splitRow(lines[0]);
  const aligns = splitRow(lines[1]).map(parseAlign);
  const rows = lines.slice(2).map(splitRow);
  return { header, aligns, rows };
}

class TableWidget extends WidgetType {
  readonly source: string;

  constructor(source: string) {
    super();
    this.source = source;
  }

  eq(other: TableWidget) {
    return other.source === this.source;
  }

  toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-wrapper";

    const parsed = parseTable(this.source);
    if (!parsed) {
      wrapper.textContent = this.source;
      return wrapper;
    }

    const { header, aligns, rows } = parsed;
    const table = document.createElement("table");
    table.className = "cm-md-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    header.forEach((cell, i) => {
      const th = document.createElement("th");
      th.textContent = cell;
      if (aligns[i]) th.style.textAlign = aligns[i]!;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      header.forEach((_, i) => {
        const td = document.createElement("td");
        td.textContent = row[i] ?? "";
        if (aligns[i]) td.style.textAlign = aligns[i]!;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    wrapper.appendChild(table);
    return wrapper;
  }

  ignoreEvent() {
    // Let clicks reach the editor so the mousedown handler can move the caret
    // into the table (revealing the source for editing).
    return false;
  }
}

function getTables(view: EditorView): DecorationSet {
  const widgets: Range<Decoration>[] = [];
  const { state } = view;
  const selection = state.selection.main;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Table") return;

        // Snap to whole-line bounds so the block replacement is valid.
        const tableFrom = state.doc.lineAt(node.from).from;
        const tableTo = state.doc.lineAt(node.to).to;

        // Keep the raw source editable whenever the selection touches the table.
        const overlaps =
          selection.from <= tableTo && selection.to >= tableFrom;
        if (overlaps) return;

        const source = state.doc.sliceString(tableFrom, tableTo);
        const deco = Decoration.replace({
          widget: new TableWidget(source),
          block: true,
        });
        widgets.push(deco.range(tableFrom, tableTo));
      },
    });
  }

  return Decoration.set(widgets, true);
}

const tablePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = getTables(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = getTables(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/** Move the caret into a rendered table when it's clicked, revealing source. */
const tableClickToEdit = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest(".cm-md-table-wrapper")) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    event.preventDefault();
    return true;
  },
});

export function tablePreview() {
  return [tablePlugin, tableClickToEdit, tableTheme];
}
