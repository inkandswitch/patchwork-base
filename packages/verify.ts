import {
  documentIdOf,
  classifyOrigin,
  moduleKey,
  moduleKeySet,
  bareModuleUrl,
  headsOf,
  pinnedModuleUrl,
  isAutomergeUrl,
  originRank,
} from "./src/origin.ts";
import { packageDisplayName } from "./src/pkg-meta.ts";

let failures = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${label}\n    expected ${e}\n    got      ${a}`);
  } else {
    console.log(`✓ ${label}`);
  }
}

// --- documentIdOf --------------------------------------------------------
eq(documentIdOf("automerge:abc123"), "abc123", "docId: bare");
eq(documentIdOf("automerge:abc123@head1|head2"), "abc123", "docId: heads-pinned");
eq(documentIdOf("automerge:abc123?x=1"), "abc123", "docId: query");
eq(documentIdOf("https://tools/foo/index.js"), undefined, "docId: http → undefined");
eq(documentIdOf(undefined), undefined, "docId: undefined");

// --- moduleKey / moduleKeySet -------------------------------------------
eq(moduleKey("automerge:mine1"), "mine1", "moduleKey: automerge → docId");
eq(moduleKey("automerge:mine2#abc"), "mine2", "moduleKey: heads-pinned → docId");
eq(moduleKey("https://x/y.js"), "https://x/y.js", "moduleKey: http → itself");
eq(moduleKey(undefined), undefined, "moduleKey: undefined");

// --- bareModuleUrl / headsOf / pinnedModuleUrl --------------------------
eq(bareModuleUrl("automerge:abc#h1|h2"), "automerge:abc", "bareModuleUrl: strips heads");
eq(bareModuleUrl("automerge:abc"), "automerge:abc", "bareModuleUrl: already bare");
eq(bareModuleUrl("https://x/y.js"), "https://x/y.js", "bareModuleUrl: http untouched");
eq(headsOf("automerge:abc#h2|h1"), ["h2", "h1"], "headsOf: splits pinned heads");
eq(headsOf("automerge:abc"), [], "headsOf: none when bare");
eq(headsOf("https://x/y.js"), [], "headsOf: http → none");
eq(
  pinnedModuleUrl("automerge:abc", ["h2", "h1"]),
  "automerge:abc#h1|h2",
  "pinnedModuleUrl: sorts + joins heads"
);
eq(
  pinnedModuleUrl("automerge:abc#stale", ["z9", "a1"]),
  "automerge:abc#a1|z9",
  "pinnedModuleUrl: re-pins from a heads-carrying url"
);
eq(pinnedModuleUrl("automerge:abc", []), undefined, "pinnedModuleUrl: none without heads");

const installed = moduleKeySet([
  "automerge:mine1",
  "automerge:mine2@abc", // heads-pinned entry still yields mine2
]);
eq([...installed].sort(), ["mine1", "mine2"], "moduleKeySet: extracts keys incl. heads");

// --- classifyOrigin ------------------------------------------------------
const system = moduleKeySet(["automerge:sys1", "https://cdn.example/tool/index.js"]);

eq(
  classifyOrigin("automerge:mine1", installed, system),
  "installed",
  "origin: module in the viewed doc → installed"
);
eq(
  classifyOrigin("automerge:mine2@deadbeef", installed, system),
  "installed",
  "origin: heads-pinned module in the viewed doc → installed"
);
eq(
  classifyOrigin("automerge:sys1@cafe", installed, system),
  "core",
  "origin: module in the system doc → core"
);
eq(
  classifyOrigin("https://cdn.example/tool/index.js", installed, system),
  "core",
  "origin: http module listed in system doc → core"
);
eq(
  classifyOrigin("automerge:someoneElse", installed, system),
  "ephemeral",
  "origin: automerge module in neither doc → ephemeral"
);
eq(
  classifyOrigin("https://tools.example/other/index.js", installed, system),
  "core",
  "origin: stray http specifier → core (site-served fallback)"
);
eq(classifyOrigin("@patchwork/file", installed, system), "core", "origin: bare specifier → core");
eq(classifyOrigin(undefined, installed, system), "unknown", "origin: no importUrl → unknown");

// --- originRank (sort weight) -------------------------------------------
eq(
  ["core", "installed", "unknown", "ephemeral"].sort(
    (a, b) => originRank(a as any) - originRank(b as any)
  ),
  ["installed", "ephemeral", "core", "unknown"],
  "originRank: installed < ephemeral < core < unknown"
);

// --- isAutomergeUrl ------------------------------------------------------
eq(isAutomergeUrl("automerge:x"), true, "isAutomergeUrl: automerge:");
eq(isAutomergeUrl("https://x"), false, "isAutomergeUrl: http");
eq(isAutomergeUrl(undefined), false, "isAutomergeUrl: undefined");

// --- packageDisplayName --------------------------------------------------
eq(
  packageDisplayName("automerge:x", { title: "My Tool", name: "@p/x" }),
  "My Tool",
  "name: prefers title"
);
eq(
  packageDisplayName("automerge:x", { name: "@p/x" }),
  "@p/x",
  "name: falls back to package name"
);
eq(
  packageDisplayName(
    "automerge:3psiCwUeZNMFrmtiAkX75Jvy1tED",
    undefined
  ),
  "automerge:3psiCwUe…",
  "name: automerge fallback shortens"
);
eq(
  packageDisplayName("https://tools.example/cache-browser/index.js", undefined),
  "cache-browser",
  "name: http fallback → dir before entry file"
);
eq(
  packageDisplayName("https://tools.example/cache-browser/", undefined),
  "cache-browser",
  "name: http fallback → trailing dir"
);
eq(
  packageDisplayName(
    "https://patchwork-base.netlify.app/tools/comments-view/dist/index.js",
    undefined
  ),
  "comments-view",
  "name: http fallback skips dist/ → package folder"
);
eq(
  packageDisplayName("https://x.example/tools/contact/dist/tool.js", undefined),
  "contact",
  "name: http fallback skips build dir before entry"
);
eq(
  packageDisplayName("@patchwork/file", undefined),
  "@patchwork/file",
  "name: bare specifier is its own name"
);
eq(packageDisplayName(undefined, undefined), "(unknown source)", "name: no url");

console.log("");
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
} else {
  console.log("ALL PASSED");
}
