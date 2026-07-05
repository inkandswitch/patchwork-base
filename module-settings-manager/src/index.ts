import { render } from "solid-js/web";
import type { ModuleSettingsDoc } from "@inkandswitch/patchwork-filesystem";
import { type ToolImplementation } from "@inkandswitch/patchwork-plugins";
import "./index.css";

const STYLE_ID = "module-settings-manager-styles";
let styleRefcount = 0;

function addStyles(textContent: string) {
  const existing = document.head.querySelector(`#${STYLE_ID}`);
  if (existing) {
    styleRefcount++;
    return;
  }
  const el = document.createElement("style");
  Object.assign(el, { textContent, id: STYLE_ID });
  document.head.append(el);
  styleRefcount++;
}

function removeStyles() {
  styleRefcount--;
  if (styleRefcount > 0) return;
  document.head.querySelector(`#${STYLE_ID}`)?.remove();
}

async function loadStyles() {
  const url = new URL("./index.css", import.meta.url);
  return (await fetch(url)).text();
}

export const plugins = [
  {
    type: "patchwork:datatype",
    id: "patchwork:module-settings",
    name: "Module Settings",
    icon: "Settings",
    unlisted: true,
    async load() {
      const { ModuleSettingsDatatype } = await import("./datatype.ts");
      return ModuleSettingsDatatype;
    },
  },
  {
    id: "module-settings-manager",
    type: "patchwork:tool",
    name: "Module Settings Manager",
    icon: "Settings",
    supportedDatatypes: ["patchwork:module-settings", "my-tools"],
    async load(): Promise<ToolImplementation<ModuleSettingsDoc>> {
      const [{ ModuleSettings }, css] = await Promise.all([
        import("./module-settings/module-settings.tsx"),
        loadStyles(),
      ]);
      return function (handle, element) {
        addStyles(css);
        const dispose = render(
          () => (
            <ModuleSettings
              handle={handle}
              repo={element.repo}
              element={element as any}
            />
          ),
          element
        );
        return () => {
          dispose();
          removeStyles();
        };
      };
    },
  },
];
