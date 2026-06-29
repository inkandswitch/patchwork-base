#!/usr/bin/env node
/**
 * Orchestrate the static tools bundle for patchwork-base.
 *
 * This is the install/build front-end that the root `package.json` scripts
 * (`build:static`, `build:static:fresh`, `build:tools:ci`) point at; the actual
 * aggregation lives in scripts/bundle.mjs.
 *
 * patchwork-base IS a pnpm workspace (`pnpm-workspace.yaml: packages: ["*"]`),
 * so installs are done once at the root (`pnpm install` wires every tool +
 * the `link:../sibling` symlinks at the same time). Builds, however, are run
 * per-tool in a loop rather than via `pnpm -r build`, for two reasons:
 *   1. Resilience — one tool failing to build shouldn't abort the whole bundle;
 *      bundle.mjs simply skips any tool without a built entry point.
 *   2. Order — the loop builds in alphabetical directory order, which puts the
 *      `link:` siblings ahead of their dependents for the current set of links
 *      (codemirror-base → codemirror-markdown/tenfold, contact → account-picker).
 *
 * Usage:
 *   node scripts/build-static.mjs                 # bundle already-built tools
 *   node scripts/build-static.mjs --build         # build each tool, then bundle
 *   node scripts/build-static.mjs --install       # root install + build each tool, then bundle
 *   node scripts/build-static.mjs --filter <name> # restrict to tools whose dir name includes <name> (repeatable)
 *   node scripts/build-static.mjs --strict         # exit non-zero if any tool fails
 *   node scripts/build-static.mjs --out <dir>      # output dir (default: static-dist)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Mirror bundle.mjs: directories that are never tools.
const IGNORE_DIRS = new Set([
  "node_modules",
  "scripts",
  "static-dist",
  "dist",
  ".git",
  ".pushwork",
]);

function parseArgs(argv) {
  const args = { out: "static-dist", install: false, build: false, strict: false, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--install") args.install = true;
    else if (a === "--build") args.build = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--filter") args.filters.push(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  // --install implies --build (no point installing without building).
  if (args.install) args.build = true;
  return args;
}

function listToolDirs(filters) {
  return readdirSync(ROOT)
    .sort()
    .filter((name) => {
      if (IGNORE_DIRS.has(name) || name.startsWith(".")) return false;
      const dir = join(ROOT, name);
      if (!statSync(dir).isDirectory()) return false;
      if (!existsSync(join(dir, "package.json"))) return false;
      if (filters.length && !filters.some((f) => name.includes(f))) return false;
      return true;
    });
}

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  return res.status === 0;
}

function main() {
  const { out, install, build, strict, filters } = parseArgs(process.argv.slice(2));
  const tools = listToolDirs(filters);

  // Workspace install once at the root — wires every tool + link: siblings.
  if (install) {
    console.log("\n── pnpm install (workspace) ──");
    if (!run("pnpm", ["install"], ROOT)) {
      console.error("[fail]  root pnpm install");
      process.exit(1);
    }
  }

  const failures = [];
  const built = [];
  const noBuild = [];

  if (build) {
    console.log(
      `\nBuilding ${tools.length} tool(s)` +
        (filters.length ? ` (filter: ${filters.join(", ")})` : "") +
        "\n"
    );

    for (const name of tools) {
      const dir = join(ROOT, name);
      const pkg = readPkg(dir);
      if (!pkg?.scripts?.build) {
        // Bundleless tools (single .js at root) have nothing to build.
        noBuild.push(name);
        continue;
      }

      console.log(`\n── build ${name} ──`);
      if (run("pnpm", ["build"], dir)) {
        built.push(name);
      } else {
        console.error(`[fail]  ${name}: pnpm build`);
        failures.push(`${name} (build)`);
      }
    }
  }

  // Aggregate whatever built into static-dist/.
  console.log(`\n── aggregating into ${out} ──`);
  const bundleOk = run("node", [join(ROOT, "scripts", "bundle.mjs"), "--out", out], ROOT);

  // Summary.
  if (build) {
    console.log(
      `\nBuilt ${built.length}, bundleless/no-build ${noBuild.length}, failed ${failures.length}.`
    );
    if (failures.length) {
      console.log("Failed tools:");
      for (const f of failures) console.log(`  - ${f}`);
    }
  }

  if (!bundleOk) process.exit(1);
  if (strict && failures.length) process.exit(1);
}

main();
