#!/usr/bin/env node
// Standalone-package linter.
//
// Every top-level tool in this repo must be pullable on its own: you should be
// able to copy one folder out of the workspace, run `pnpm install` + the build
// inside it, and get the same result. That breaks the moment a package.json
// leans on something only the workspace provides. This script scans every
// per-tool package.json and fails if it finds such a dependency.
//
// Forbidden dependency specifiers (in dependencies / devDependencies /
// peerDependencies / optionalDependencies):
//   workspace:*  - pnpm workspace protocol; only resolvable inside the workspace
//   catalog:*    - pnpm catalog protocol; version lives in pnpm-workspace.yaml
//   link:../x    - symlink to a sibling folder; gone once the folder is alone
//   file:../x    - tarball/dir reference that escapes the package folder
//
// Run from the repo root: `node scripts/lint-standalone.mjs` (or `pnpm lint`).

import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]

// specifier -> human-readable reason
const FORBIDDEN = [
  [/^workspace:/, "uses the pnpm `workspace:` protocol"],
  [/^catalog:/, "uses the pnpm `catalog:` protocol (version defined in pnpm-workspace.yaml)"],
  [/^link:/, "uses `link:` to a sibling folder"],
  [/^file:/, "uses `file:` to a path outside the package"],
]

function packageDirs() {
  return fs
    .readdirSync(root)
    .filter((name) => {
      if (name === "node_modules" || name.startsWith(".")) return false
      const dir = path.join(root, name)
      return (
        fs.statSync(dir).isDirectory() &&
        fs.existsSync(path.join(dir, "package.json"))
      )
    })
    .sort()
}

const violations = []

for (const name of packageDirs()) {
  const pjPath = path.join(root, name, "package.json")
  let pj
  try {
    pj = JSON.parse(fs.readFileSync(pjPath, "utf8"))
  } catch (err) {
    violations.push({pkg: name, dep: "package.json", spec: "", reason: `is not valid JSON: ${err.message}`})
    continue
  }

  for (const field of DEP_FIELDS) {
    const deps = pj[field]
    if (!deps || typeof deps !== "object") continue
    for (const [dep, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue
      for (const [re, reason] of FORBIDDEN) {
        if (re.test(spec)) {
          violations.push({pkg: name, field, dep, spec, reason})
        }
      }
    }
  }
}

if (violations.length === 0) {
  console.log("✓ all packages are standalone (no workspace-only dependency specifiers)")
  process.exit(0)
}

console.error(`✗ found ${violations.length} workspace-only dependency specifier(s):\n`)
for (const v of violations) {
  console.error(`  ${v.pkg}/package.json → ${v.field}.${v.dep}`)
  console.error(`    "${v.spec}"  ${v.reason}`)
  console.error(`    fix: replace with a registry version range so the folder installs on its own.\n`)
}
process.exit(1)
