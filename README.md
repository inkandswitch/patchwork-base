# patchwork-core

Standalone Patchwork tools, extracted from
[`patchwork-next`](https://github.com/inkandswitch/patchwork-next)'s `tools/`
directory with full git history preserved.

Each top-level folder is an independent package with its own `package.json`,
build, and lockfile. No root workspace — `cd` into a tool and run its scripts.

## Tools

```
account-history             frame-configurator
account-picker              history-view
add-doc-to-sidebar-button   latex
back-link-button            module-settings-manager
codemirror-base             orionmark
codemirror-embed            patchwork-frame
codemirror-markdown         sidebar-toggles
commands                    sideboard
comments-view               space-frame
contact                     spacer
context-sidebar             sync-indicator
context-view                tenfold
doc-title                   tldraw4
```

## Building a tool

```sh
cd history-view
pnpm install
pnpm build
```

Tools depend on published `@inkandswitch/patchwork-*` and related npm
packages rather than workspace siblings.
