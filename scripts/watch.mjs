import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", "scripts", "static-dist", ".git"]);
const watchers = [];
let bundleTimer;
let stopping = false;

function bundle() {
  const result = spawnSync("node", ["scripts/bundle.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) stop(result.status ?? 1);
}

function schedule() {
  clearTimeout(bundleTimer);
  bundleTimer = setTimeout(bundle, 1000);
}

function watchOutput(path) {
  const watcher = watch(
    path,
    { recursive: statSync(path).isDirectory() },
    schedule,
  );
  watcher.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  watchers.push(watcher);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(bundleTimer);
  for (const watcher of watchers) watcher.close();
  tools.kill("SIGTERM");
  process.exitCode = code;
}

if (!existsSync(join(root, "static-dist", "modules.json"))) {
  for (const [command, args] of [
    ["pnpm", ["-r", "--if-present", "build"]],
    ["node", ["scripts/bundle.mjs"]],
  ]) {
    const initial = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (initial.status !== 0) process.exit(initial.status ?? 1);
  }
}

for (const name of readdirSync(root)) {
  if (ignored.has(name) || name.startsWith(".")) continue;
  const directory = join(root, name);
  if (!statSync(directory).isDirectory()) continue;
  if (!existsSync(join(directory, "package.json"))) continue;
  const dist = join(directory, "dist");
  if (existsSync(dist)) watchOutput(dist);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (
      entry.name === "package.json" ||
      entry.name === "example.js" ||
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".mjs")
    ) {
      watchOutput(join(directory, entry.name));
    }
  }
}

const tools = spawn(
  "pnpm",
  ["-r", "--parallel", "--if-present", "dev"],
  { cwd: root, stdio: "inherit" },
);
tools.on("exit", (code) => {
  if (!stopping) stop(code ?? 1);
});
tools.on("error", (error) => {
  console.error(error.message);
  stop(1);
});

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
