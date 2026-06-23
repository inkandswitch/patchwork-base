# patchwork-base

A collection of the core tools that comprise the Patchwork system.

## Engineering Notes

Tools in this collection should be reliable and maintained: these are the core tools, after all.

Within a given distribution, it is reasonable to assume these tools exist, however tools in this collection should never assume the existence of other tools.

Regardless, these tools should not depend on each other's implementations or their internal structure.

Each directory in this collection can be built completely independently. Tools do not share lockfiles, node modules, or even necessarily build systems or web frameworks.

Please be careful not to violate these isolation principles.

## Dependencies

- External deps (`@inkandswitch/patchwork-*`, `solid-js`, etc.) are pinned to
  normal published npm versions.

## Caveat

- A few tools depend on sibling tools in this repo
  (`codemirror-markdown` → `codemirror-base`, `tenfold` → `codemirror-base` and
  `codemirror-markdown`, `account-picker` → `contact`). Those are referenced as
  `link:../<sibling>` in the sibling's `package.json`, which creates a live
  symlink into `node_modules`. Building the sibling is enough — no publish
  step, no `workspace:*` protocol.

## Building one tool

```sh
cd history-view
pnpm install
pnpm build
```

For tools that `link:` to a sibling, build the sibling first so its `dist/`
exists (e.g. `codemirror-base` before `tenfold`). Running `pnpm -r build` at
the root happens to go in alphabetical order, which puts dependencies ahead of
dependents for the current set of links.

## Building everything

From the repo root:

```sh
pnpm -r install   # install in every tool
pnpm -r build     # build every tool that has a build script
```

## Static-HTTP deployment (shell + tools bundle)

The tools can be deployed as a static HTTP bundle and loaded by any Patchwork
**shell** (the boot runtime). The two halves are independent:

- **Tools bundle** (lives here) — `static-dist/` (`modules.json` +
  `tools/<tool>/dist/…`), produced by `scripts/build-static.mjs`. Deployed to
  Netlify (the repo is private, so GitHub Pages would need a paid plan).
  `build:static` also writes a `_headers` file granting
  `Access-Control-Allow-Origin: *`, which Netlify (and Cloudflare Pages) honour
  so a shell can load these tools cross-origin.
- **Shell** (lives in `patchwork-next`) — there is no separate shell in this
  repo. Any patchwork-next site is a shell; `sites/tiny-patchwork` is the
  canonical one (PWA-ready). The static-manifest support lives in the bootloader
  (`ModuleWatcher` / `SiteConfig.defaultModules`), so a shell just needs to point
  its `defaultModules` at a tools host.

A shell can point at any tools host via `VITE_DEFAULT_MODULES` (build time) or
`localStorage.defaultToolsUrl` (runtime), so the same deployed shell can run
against an `automerge:` module-settings doc, this static tools bundle, a PR
preview, or a local tools server — no shell rebuild needed for the runtime
override.

### Build / serve / deploy the tools bundle

```sh
pnpm build:static     # aggregate already-built tool dist/ -> static-dist/ + modules.json
pnpm build:static:fresh  # also run each tool's own `pnpm build` first
pnpm build:tools:ci   # also `pnpm install` in each tool first (for clean CI)

pnpm serve:tools      # serve static-dist/ on :4455 with CORS (local tools host)
pnpm dev:tools        # build:static + serve:tools

pnpm deploy:tools     # build:static + netlify deploy --prod (static-dist/)
```

`modules.json` uses relative `./tools/…` URLs that resolve against the
manifest's own URL, so the bundle works at any host or base path.

The first `pnpm deploy:tools` will prompt you to log in and link/create a
Netlify site (`netlify.toml` sets the publish dir). After that it's one command.

### Continuous deploy + PR previews (Netlify Git integration)

Deploys are handled entirely by **Netlify** — no GitHub Actions, no secrets/
tokens. Connect the repo once in the Netlify dashboard (Add new site → import
this repo). Netlify reads `netlify.toml` (build command `pnpm build:tools:ci`,
publish dir `static-dist`) and then:

- **push to the production branch** → production deploy
- **pull request** → automatic Deploy Preview at
  `https://deploy-preview-<n>--<site>.netlify.app`

**Environment variables:** none required. The tools build needs no secrets. The
only build setting is the Node version, pinned in `netlify.toml`
(`NODE_VERSION`); pnpm is auto-detected from the lockfile (pin `PNPM_VERSION`
there if you need an exact version).

The preview is of the *tools bundle*, so to test a PR's tools in any shell,
point it at the preview's manifest — no shell rebuild needed:

```js
localStorage.defaultToolsUrl = "https://deploy-preview-123--<site>.netlify.app/modules.json"
```

(Shell changes are a separate deploy and aren't previewed here.)

### Run a shell against a local tools bundle

```sh
# terminal 1 — tools host (in patchwork-base)
pnpm dev:tools

# terminal 2 — shell (in patchwork-next)
VITE_DEFAULT_MODULES=http://localhost:4455/modules.json \
  pnpm --filter tiny-patchwork dev
```

At runtime you can also point an already-running/deployed shell at a tools host
without a rebuild:

```js
localStorage.defaultToolsUrl = "http://localhost:4455/modules.json"
```

## Installing modules

Right now this is a bit janky, but once you have the pushwork and the patchwork-modules CLI tool installed, you should be able to run:

```sh
export MODULE_SETTINGS_DOC_URL=automerge:$A_RELEVANT_URL
pnpm -r exec pushwork init --sub
pnpm -r register
```

NB: The --sub is because as of this writing, we're using a prerelease of subduction support for pushwork.
