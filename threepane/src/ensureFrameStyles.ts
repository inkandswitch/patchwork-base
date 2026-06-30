// Imported as a string (not a side-effect import) so the stylesheet is only
// injected when the frame tool actually activates — not when index.js loads.
import frameStyles from "./styles.css?inline";

/**
 * Inject the threepane stylesheet into the current realm's document, once.
 *
 * Called from both realms: host-side by `PatchworkFrame`, and inside the isolated iframe by
 * `IsolationRoot`.
 */
export function ensureFrameStyles() {
  const id = "patchwork-frame-styles";
  if (document.getElementById(id)) return;
  const el = document.createElement("style");
  el.id = id;
  el.textContent = frameStyles;
  document.head.append(el);
}
