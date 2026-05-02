import { DocHandle } from "@automerge/automerge-repo";
import { annotations as globalAnnotations } from "@inkandswitch/annotations-context";
import { computed } from "@inkandswitch/subscribables";
import type { Ref } from "@automerge/automerge-repo";
import type { AnnotationsOnRef } from "@inkandswitch/annotations";
import "./styles.css";

const $sortedRefs = computed(globalAnnotations, () =>
  Array.from(
    new Set(
      Array.from(globalAnnotations.refs).sort((a, b) =>
        a.toString().localeCompare(b.toString())
      )
    )
  )
);

(window as any).$context = {
  dump() {
    return Array.from([...globalAnnotations]).map(([ref, annotation]) => {
      return [
        ref.toString(),
        annotation.type.id,
        valueToString(annotation.value),
      ];
    });
  },
  refs: () => Array.from(globalAnnotations.refs),
};

const valueToString = (value: any) => {
  try {
    return JSON.stringify(value, (_key, value) => {
      if (
        typeof value === "object" &&
        "docHandle" in value &&
        value.docHandle instanceof DocHandle &&
        "path" in value.docHandle
      ) {
        return value.toString();
      }
      return value;
    });
  } catch {
    return String(value);
  }
};

function createRefView(ref: Ref): { element: HTMLElement; destroy: () => void } {
  const cleanups: (() => void)[] = [];

  const refRow = document.createElement("tr");
  const refCell = document.createElement("td");
  refCell.className = "px-6 py-2 whitespace-nowrap text-sm text-gray-900";
  refCell.colSpan = 2;
  const refBadge = document.createElement("span");
  refBadge.className =
    "bg-blue-100 border border-blue-300 rounded-md p-1 font-mono";
  refBadge.textContent = ref.toString();
  refCell.appendChild(refBadge);
  refRow.appendChild(refCell);

  const valueRow = document.createElement("tr");
  const valueLabelCell = document.createElement("td");
  valueLabelCell.className = "px-6 py-2 whitespace-nowrap text-sm text-gray-900";
  valueLabelCell.textContent = "value";
  const valueCell = document.createElement("td");
  valueCell.className =
    "px-6 py-2 whitespace-nowrap text-sm text-blue-900 font-mono";
  valueCell.textContent = valueToString(ref.value());
  valueRow.append(valueLabelCell, valueCell);

  const unsubRef = ref.onChange(() => {
    valueCell.textContent = valueToString(ref.value());
  });
  cleanups.push(unsubRef);

  const annotationRows: HTMLElement[] = [];
  const annotationsView: AnnotationsOnRef = globalAnnotations.onRef(ref);

  function renderAnnotations() {
    for (const row of annotationRows) row.remove();
    annotationRows.length = 0;

    for (const [, annotation] of annotationsView) {
      const row = document.createElement("tr");
      const labelCell = document.createElement("td");
      labelCell.className =
        "px-6 py-2 whitespace-nowrap text-sm text-gray-900";
      labelCell.textContent = annotation.type.id;
      const valCell = document.createElement("td");
      valCell.className =
        "px-6 py-2 whitespace-nowrap text-sm text-blue-900 font-mono";
      valCell.textContent = valueToString(annotation.value);
      row.append(labelCell, valCell);
      annotationRows.push(row);
      valueRow.after(...annotationRows);
    }
  }

  renderAnnotations();
  const unsubAnnotations = annotationsView.subscribe(() => renderAnnotations());
  cleanups.push(unsubAnnotations);

  const container = document.createElement("tbody");
  container.append(refRow, valueRow, ...annotationRows);

  return {
    element: container,
    destroy() {
      for (const fn of cleanups) fn();
      container.remove();
    },
  };
}

export function renderContextView(
  _handle: DocHandle<unknown>,
  element: HTMLElement
) {
  element.className += " w-full h-full overflow-auto";

  const table = document.createElement("table");
  table.className = "divide-y divide-gray-200";

  const thead = document.createElement("thead");
  thead.className = "bg-gray-50";
  thead.innerHTML = `<tr>
    <th class="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Ref</th>
    <th class="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th>
  </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.className = "bg-white";
  table.appendChild(tbody);
  element.appendChild(table);

  let refViews: { ref: Ref; element: HTMLElement; destroy: () => void }[] = [];

  function render(refs: Ref[]) {
    for (const view of refViews) view.destroy();
    refViews = [];

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const view = createRefView(ref);
      refViews.push({ ref, ...view });
      tbody.appendChild(view.element);

      if (i < refs.length - 1) {
        const separator = document.createElement("tr");
        const sepCell = document.createElement("td");
        sepCell.colSpan = 2;
        sepCell.className = "px-6 py-2";
        sepCell.innerHTML = `<hr class="border-gray-200" />`;
        separator.appendChild(sepCell);
        tbody.appendChild(separator);
      }
    }
  }

  render($sortedRefs.value);

  const unsub = $sortedRefs.subscribe((refs) => render(refs));

  return () => {
    unsub();
    for (const view of refViews) view.destroy();
    element.removeChild(table);
  };
}
