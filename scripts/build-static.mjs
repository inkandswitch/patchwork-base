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
 * per-tool rather than via `pnpm -r build`, for two reasons:
 *   1. Resilience — one tool failing to build shouldn't abort the whole bundle;
 *      bundle.mjs simply skips any tool without a built entry point.
 *   2. Order — a tool that `link:`s a sibling (e.g. account-picker → contact)
 *      must not build until that sibling has built. We derive this dependency
 *      graph from each tool's `link:../sibling` deps and build in parallel,
 *      gating each tool on its siblings, instead of relying on directory order.
 *
 * Tools build concurrently (up to `BUILD_CONCURRENCY`, default = CPUs - 1).
 * Each tool's output is buffered and flushed as a block when it finishes so the
 * interleaved logs stay readable.
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
import { spawnSync, spawn } from "node:child_process";
import { availableParallelism } from "node:os";
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

// Async variant used for the parallel build loop. Buffers stdout+stderr so a
// tool's log can be flushed as one contiguous block once it completes.
function runBuffered(cmd, args, cwd) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(cmd, args, { cwd, shell: false });
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => resolve({ ok: false, output: `${err}\n` }));
    child.on("close", (code) =>
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString("utf8") })
    );
  });
}

// The subset of `link:../sibling` deps that point at another tool in the build
// set — these must build before this tool does.
function linkDeps(dir, toolSet) {
  const pkg = readPkg(dir);
  const all = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const deps = new Set();
  for (const spec of Object.values(all)) {
    if (typeof spec === "string" && spec.startsWith("link:")) {
      const base = spec.slice("link:".length).split("/").pop();
      if (toolSet.has(base)) deps.add(base);
    }
  }
  return [...deps];
}

/**
 * Build every tool with a `build` script concurrently, respecting `link:`
 * sibling ordering and a concurrency cap. Returns { built, noBuild, failures }.
 */
async function buildTools(tools, concurrency) {
  const buildable = [];
  const noBuild = [];
  for (const name of tools) {
    if (readPkg(join(ROOT, name))?.scripts?.build) buildable.push(name);
    else noBuild.push(name); // bundleless tools (single .js at root)
  }

  const toolSet = new Set(buildable);
  const depsOf = new Map(buildable.map((n) => [n, linkDeps(join(ROOT, n), toolSet)]));
  const done = new Set();
  const built = [];
  const failures = [];
  const remaining = new Set(buildable);
  const inFlight = new Set();

  await new Promise((resolveAll) => {
    function launch(name) {
      remaining.delete(name);
      inFlight.add(name);
      runBuffered("npx", ["pnpm@11", "build"], join(ROOT, name)).then(({ ok, output }) => {
        process.stdout.write(`\n── build ${name} ──\n${output}`);
        if (ok) built.push(name);
        else {
          console.error(`[fail]  ${name}: pnpm build`);
          failures.push(`${name} (build)`);
        }
        inFlight.delete(name);
        done.add(name);
        schedule();
      });
    }

    function schedule() {
      if (remaining.size === 0 && inFlight.size === 0) {
        resolveAll();
        return;
      }
      let launchedAny = false;
      for (const name of [...remaining]) {
        if (inFlight.size >= concurrency) break;
        // Gate on completion (not success): the link symlink already exists;
        // we only need the sibling's own build to have run first.
        if (!depsOf.get(name).every((d) => done.has(d))) continue;
        launch(name);
        launchedAny = true;
      }
      // Deadlock guard: if nothing is running and nothing became eligible (e.g.
      // a link cycle), force the remaining tools rather than hang forever.
      if (!launchedAny && inFlight.size === 0 && remaining.size > 0) {
        for (const name of [...remaining]) {
          if (inFlight.size >= concurrency) break;
          launch(name);
        }
      }
    }

    schedule();
  });

  return { built, noBuild, failures };
}

async function main() {
  const { out, install, build, strict, filters } = parseArgs(process.argv.slice(2));
  const tools = listToolDirs(filters);

  // Workspace install once at the root — wires every tool + link: siblings.
  if (install) {
    console.log("\n── pnpm install (workspace) ──");
    if (!run("npx", ["pnpm@11", "install"], ROOT)) {
      console.error("[fail]  root pnpm install");
      process.exit(1);
    }
  }

  let failures = [];
  let built = [];
  let noBuild = [];

  if (build) {
    const concurrency = Math.max(
      1,
      Number(process.env.BUILD_CONCURRENCY) || availableParallelism() - 1
    );
    console.log(
      `\nBuilding ${tools.length} tool(s) (concurrency: ${concurrency})` +
        (filters.length ? ` (filter: ${filters.join(", ")})` : "") +
        "\n"
    );

    ({ built, noBuild, failures } = await buildTools(tools, concurrency));
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
