#!/usr/bin/env node
/**
 * Aggregate every patchwork-base tool's built `dist/` into a single static,
 * HTTP-servable directory plus a `modules.json` manifest.
 *
 * The manifest has the same shape as a Patchwork module-settings document
 * (`{ "@patchwork": { type: "patchwork:module-settings" }, modules: [...] }`)
 * but lives as a plain JSON file. Each module entry is a relative URL to a
 * tool's entry-point JS, resolved the same way the runtime resolves an
 * Automerge folder doc's package.json (`exports["."]` under the
 * `patchwork`/`browser`/`import` conditions, falling back to `main`).
 *
 * Usage:
 *   node scripts/build-static.mjs [--out <dir>] [--install] [--build]
 *
 *   --out <dir>   Output directory (default: static-dist)
 *   --install     Run `pnpm install` in each tool before building. Implies
 *                 --build. Useful in CI where tool node_modules are absent.
 *   --build       Run each tool's own `pnpm build` (in its isolated
 *                 node_modules) before copying. Off by default; we copy the
 *                 existing dist/.
 */
import { existsSync, readFileSync, rmSync, mkdirSync, cpSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// Conditions mirror `defaultImportConditions` in
// @inkandswitch/patchwork-filesystem so static resolution matches runtime.
const CONDITIONS = ["patchwork", "browser", "import"];

// Directories that are never tools.
const IGNORE_DIRS = new Set([
  "node_modules",
  "scripts",
  "static-dist",
  "dist",
  ".git",
  ".pushwork",
]);

function parseArgs(argv) {
  const args = { out: "static-dist", build: false, install: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--build") args.build = true;
    else if (a === "--install") {
      args.install = true;
      args.build = true;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/**
 * Resolve a package.json `exports`/`main` for the root subpath under our
 * import conditions. Returns a path relative to the package root (e.g.
 * "./dist/index.js") or undefined.
 */
function resolveEntry(pkg) {
  const exp = pkg.exports;
  const fromExports = exp ? resolveExportValue(exp["."] ?? exp) : undefined;
  if (fromExports) return fromExports;
  if (typeof pkg.main === "string") return pkg.main;
  return undefined;
}

function resolveExportValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  for (const cond of CONDITIONS) {
    if (cond in value) {
      const resolved = resolveExportValue(value[cond]);
      if (resolved) return resolved;
    }
  }
  if ("default" in value) return resolveExportValue(value.default);
  return undefined;
}

function normalizeRel(p) {
  return p.replace(/^\.\//, "").replace(/^\//, "");
}

function main() {
  const { out, build, install } = parseArgs(process.argv.slice(2));
  const outDir = resolvePath(ROOT, out);
  const toolsOutDir = join(outDir, "tools");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(toolsOutDir, { recursive: true });

  const modules = [];
  const skipped = [];

  for (const name of readdirSync(ROOT).sort()) {
    if (IGNORE_DIRS.has(name) || name.startsWith(".")) continue;
    const toolDir = join(ROOT, name);
    if (!statSync(toolDir).isDirectory()) continue;

    const pkgPath = join(toolDir, "package.json");
    if (!existsSync(pkgPath)) {
      skipped.push(`${name} (no package.json)`);
      continue;
    }

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    if (install) {
      console.log(`[install] ${name}: pnpm install`);
      execSync("pnpm install --prefer-offline", {
        cwd: toolDir,
        stdio: "inherit",
      });
    }

    if (build && pkg.scripts?.build) {
      console.log(`[build] ${name}: pnpm build`);
      execSync("pnpm build", { cwd: toolDir, stdio: "inherit" });
    }

    const distDir = join(toolDir, "dist");
    if (!existsSync(distDir)) {
      skipped.push(`${name} (no dist/ — run with --build or build it first)`);
      continue;
    }

    const entry = resolveEntry(pkg);
    if (!entry) {
      skipped.push(`${name} (no resolvable entry point in package.json)`);
      continue;
    }

    const entryRel = normalizeRel(entry);
    if (!existsSync(join(toolDir, entryRel))) {
      skipped.push(`${name} (entry ${entryRel} missing from build output)`);
      continue;
    }

    const destDir = join(toolsOutDir, name);
    mkdirSync(destDir, { recursive: true });
    cpSync(distDir, join(destDir, "dist"), { recursive: true });
    cpSync(pkgPath, join(destDir, "package.json"));

    modules.push(`./tools/${name}/${entryRel}`);
    console.log(`[ok]    ${name} -> ./tools/${name}/${entryRel}`);
  }

  const manifest = {
    "@patchwork": { type: "patchwork:module-settings" },
    modules,
  };
  writeFileSync(join(outDir, "modules.json"), JSON.stringify(manifest, null, 2) + "\n");

  // The shell loads these tools cross-origin, and module `import()` is always a
  // CORS request, so the tools host must allow it. `_headers` is read by Netlify
  // (and Cloudflare Pages), so the bundle is portable across static hosts.
  writeFileSync(
    join(outDir, "_headers"),
    ["/*", "  Access-Control-Allow-Origin: *", ""].join("\n")
  );

  console.log(`\nWrote ${modules.length} modules to ${join(outDir, "modules.json")}`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
}

main();
