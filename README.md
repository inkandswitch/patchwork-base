# patchwork-core

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

## Installing modules

Right now this is a bit janky, but once you have the pushwork and the patchwork-modules CLI tool installed, you should be able to run:

```sh
export MODULE_SETTINGS_DOC_URL=automerge:$A_RELEVANT_URL
pnpm -r exec pushwork init --sub
pnpm -r register
```

NB: The --sub is because as of this writing, we're using a prerelease of subduction support for pushwork.
