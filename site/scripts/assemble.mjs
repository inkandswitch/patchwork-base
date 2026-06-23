#!/usr/bin/env node
/**
 * Copy the aggregated static tool bundle (produced by the root
 * `scripts/build-static.mjs`, which runs as this site's `prebuild`) into the
 * Vite build output so the whole thing deploys as a single static directory.
 *
 * After this runs, `site/dist/` contains the app shell plus:
 *   - dist/modules.json        the default tool manifest
 *   - dist/tools/<tool>/dist/  each tool's compiled bundle
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(SITE, "..");
const staticDist = join(ROOT, "static-dist");
const dist = join(SITE, "dist");

if (!existsSync(join(staticDist, "modules.json"))) {
  throw new Error(
    `Missing ${join(staticDist, "modules.json")}. Run \`node ../scripts/build-static.mjs\` first (the site's prebuild does this automatically).`
  );
}
if (!existsSync(dist)) {
  throw new Error(`Missing ${dist}. Run \`vite build\` first.`);
}

cpSync(join(staticDist, "tools"), join(dist, "tools"), { recursive: true });
cpSync(join(staticDist, "modules.json"), join(dist, "modules.json"));

console.log(`Assembled static tool bundle into ${dist}`);
