import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set(["node_modules", "scripts", "static-dist", ".git"]);
const watchers = [];
const pending = new Set();
const children = [];
let bundleTimer;
let stopping = false;

function bundle() {
  const current = join(root, "static-dist");
  const names = [...pending];
  pending.clear();
  const args = ["scripts/bundle.mjs", "--strict"];
  for (const name of names) args.push("--filter", name);
  const result = spawnSync("node", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) return;
  writeFileSync(join(current, ".watch-ready"), `${Date.now()}\n`);
}

function schedule(name) {
  pending.add(name);
  clearTimeout(bundleTimer);
  bundleTimer = setTimeout(bundle, 500);
}

function watchOutput(name, path) {
  const watcher = watch(
    path,
    { recursive: statSync(path).isDirectory() },
    () => schedule(name),
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
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

// Each tool installs and runs on its own (there's no workspace here), so this
// goes through them one by one rather than with `pnpm -r`, which would find
// the workspace of whatever repo this folder sits in, if it sits in one.
if (!existsSync(join(root, "static-dist", "modules.json"))) {
  for (const args of [["scripts/each.mjs", "build"], ["scripts/bundle.mjs"]]) {
    const initial = spawnSync("node", args, { cwd: root, stdio: "inherit" });
    if (initial.status !== 0) process.exit(initial.status ?? 1);
  }
}

for (const name of readdirSync(root)) {
  if (ignored.has(name) || name.startsWith(".")) continue;
  const directory = join(root, name);
  if (!statSync(directory).isDirectory()) continue;
  if (!existsSync(join(directory, "package.json"))) continue;
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (pkg.scripts?.dev) dev(name, directory);
  const dist = join(directory, "dist");
  if (existsSync(dist)) watchOutput(name, dist);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (
      entry.name === "package.json" ||
      entry.name === "example.js" ||
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".mjs")
    ) {
      watchOutput(name, join(directory, entry.name));
    }
  }
}

function dev(name, directory) {
  const child = spawn("pnpm", ["dev"], { cwd: directory, stdio: "inherit" });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`${name}: dev exited (${code})`);
      stop(code ?? 1);
    }
  });
  child.on("error", (error) => {
    console.error(`${name}: ${error.message}`);
    stop(1);
  });
  children.push(child);
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
