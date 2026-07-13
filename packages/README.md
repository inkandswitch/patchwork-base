# Packages

A visualizer for the **live** `@inkandswitch/patchwork-plugins` registries.

Unlike the Module Settings Manager — which is a view of *your* module-settings doc
(the list of automerge URLs you've installed) — this tool renders the **actual
in-memory registries** the host has populated (`getAllRegistries()`). Because the
importmap resolves `@inkandswitch/patchwork-plugins` to the host's singleton, what
you see here is the real, running registry state, updating live as plugins are
registered, loaded, or shadowed.

It still takes a **module-settings doc** as its handle — but only to tell **yours**
from **core**: it reads `doc.modules` and cross-references each plugin's `importUrl`.

## Three ways to look at it

- **Packages** — grouped by `importUrl`, each group named by the `package.json` at
  that source (`title` → `name` → a URL-derived fallback), with its version and the
  plugins it contributes.
- **Registries** — grouped by registry type (`patchwork:tool`, `patchwork:datatype`,
  `patchwork:component`, `patchwork:theme`, `codemirror:extension`, and any others
  minted at runtime).
- **Table** — a flat, sortable list (name / registry / id / package / origin / importUrl).

Plus: search (name, id, type, package, importUrl), a registry-type filter, and an
origin filter with counts.

## Origin

Provenance is inferred from `importUrl` (the registry has no "core" flag):

| badge | meaning | importUrl |
|---|---|---|
| **yours** | installed via *this* settings doc | `automerge:` URL whose docId is in `doc.modules` |
| **installed** | loaded from some other automerge source | other `automerge:` URL |
| **core** | shipped by the site's default/system bundle | `http(s)://` or a bare specifier |

Every plugin shows its `importUrl` (click to copy); automerge sources get an
**open doc** button.

## Build & publish

Bundled Solid tool (vite). `@inkandswitch/patchwork-plugins` is left **external** so
it resolves to the host's live singleton — don't bundle it.

```sh
pnpm install
pnpm build          # or: ./node_modules/.bin/vite build
pushwork sync       # publish; prints the automerge: URL to install
```

Then **install** the printed URL in your module-settings doc (the Module Settings
Manager's "Install" field, or `pw-modules add <settings-doc-url> <tool-url>`) so the
tool id `packages` resolves.

The host's account-bar "Packages" link has been pointed at this tool
(`toolId: "packages"`) in `base/threepane/src/PatchworkFrame.tsx` and
`base/sideboard/src/sideboard/account-bar.tsx`; rebuild base for that to take effect.

## Files

- `src/index.tsx` — worker-safe entry: metadata + `load()` only (no static externals).
- `src/mount.tsx` — the `(handle, element) => cleanup` render contract.
- `src/registry.ts` — live snapshot of `getAllRegistries()` + subscriptions.
- `src/origin.ts` — yours / installed / core classification.
- `src/pkg-meta.ts` — package.json name/version resolution per importUrl.
- `src/packages.tsx` — the three views + filters.
- `verify.ts` — `node --experimental-strip-types verify.ts` runs the logic tests.
