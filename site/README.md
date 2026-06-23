# patchwork-base-site

A **self-contained static-HTTP deployment** of the patchwork-base tools. Unlike
the sites in `patchwork-next` (which boot from an Automerge module-settings
document hosted on Subduction), this site loads its default tool bundle from a
plain static JSON manifest served alongside the compiled tools.

You can still mix in Automerge-hosted tools — see [Mixing deployment
targets](#mixing-deployment-targets).

## How it works

1. `scripts/build-static.mjs` (in the repo root) aggregates every tool's built
   `dist/` into `../static-dist/tools/<tool>/` and writes a `modules.json`
   manifest listing each tool's entry-point URL. The manifest has the same shape
   as a Patchwork module-settings document, but it is a static file.
2. This site's `src/main.ts` boots with `defaultModules: ["/modules.json"]`.
3. At runtime the bootloader's `ModuleWatcher` fetches `/modules.json` and
   dynamically `import()`s each tool over HTTP. The tools' shared dependencies
   (Automerge, Solid, the plugin system, …) resolve through the import map that
   the bootloader's Vite plugin injects into `index.html`.

The result in `dist/` is a single directory you can drop on any static host
(it includes `_headers`/`_redirects` for Netlify-style hosts; you need
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless` for SharedArrayBuffer/WASM).

## Build

```sh
pnpm install
pnpm build      # runs the aggregator (prebuild) + vite build + assemble
pnpm preview    # serve dist/ locally with the required COOP/COEP headers
```

`pnpm build` produces:

```
dist/
  index.html
  packages/*.js        shared externals (import map targets)
  *.wasm               automerge / subduction / keyhive
  service-worker.js
  modules.json         default tool manifest
  tools/<tool>/dist/   each tool's compiled bundle
```

## Mixing deployment targets

Both the *source of the module list* and *each module within it* can be either
static HTTP or Automerge, so you can freely combine deployment targets:

- **Add an Automerge tool set alongside the static one** — pass several sources:

  ```ts
  await bootPatchworkSite({
    defaultModules: ["/modules.json", "automerge:…"],
    // …
  });
  ```

- **Per-tool mixing** — a `modules.json` (or an Automerge settings doc) may list
  both `automerge:…` folder-doc URLs and `https://…/index.js` bundles.

- **Runtime override** — set `localStorage.defaultToolsUrl` to another manifest
  URL (`/some-other.json`, `https://…`) or an `automerge:` URL to replace the
  built-in default bundle without rebuilding.

- **Per-user tools** — each user's personal Automerge module-settings doc
  (created by the frame) continues to layer on top of the site default.

## Dependency note (Piece B must be available)

This site depends on `@inkandswitch/patchwork-bootloader@^0.3.0` and
`@inkandswitch/patchwork-filesystem@^0.1.0`, which add the static-manifest
module source. Until those versions are published to npm, install will fail to
resolve them. For local development against an unpublished bootloader, pack the
local builds from `patchwork-next` and reference them via pnpm `overrides`:

```sh
# in patchwork-next
pnpm --filter @inkandswitch/patchwork-filesystem build
pnpm --filter @inkandswitch/patchwork-bootloader build
pnpm --filter @inkandswitch/patchwork-filesystem exec pnpm pack
pnpm --filter @inkandswitch/patchwork-bootloader exec pnpm pack
```

then add to this site's `package.json`:

```json
"pnpm": {
  "overrides": {
    "@inkandswitch/patchwork-filesystem": "file:/abs/path/inkandswitch-patchwork-filesystem-0.1.0.tgz",
    "@inkandswitch/patchwork-bootloader": "file:/abs/path/inkandswitch-patchwork-bootloader-0.3.0.tgz"
  }
}
```
