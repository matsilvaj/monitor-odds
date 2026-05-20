import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const envPath = path.join(projectRoot, ".env");

function commandLine(command, args) {
  if (process.platform === "win32") return [command, ...args].join(" ");
  if (process.platform !== "win32") return [command, ...args].map((part) => `'${String(part).replace(/'/g, "'\\''")}'`).join(" ");
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh", [process.platform === "win32" ? "/c" : "-c", commandLine(command, args)], {
      cwd: launcherRoot,
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
      ...options
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} saiu com codigo ${code}`));
    });
  });
}

try {
  const parsedEnv = parse(await readFile(envPath, "utf8"));
  process.env.GH_TOKEN ??= parsedEnv.GH_TOKEN ?? parsedEnv.GITHUB_TOKEN ?? parsedEnv.GITHUB_RELEASE_TOKEN;
} catch {
  // O token tambem pode ser informado direto no ambiente do terminal.
}

if (!process.env.GH_TOKEN) {
  throw new Error("GH_TOKEN não encontrado. Configure GH_TOKEN no .env ou no ambiente do terminal antes de publicar.");
}

const npmCommand = "npm";
const nodeCommand = "node";
const electronBuilderCommand = process.platform === "win32" ? "node_modules\\.bin\\electron-builder.cmd" : path.join(launcherRoot, "node_modules", ".bin", "electron-builder");

await run(npmCommand, ["--prefix", "..", "run", "build"]);
await run(nodeCommand, ["scripts/write-env-resource.js"]);
await run(electronBuilderCommand, ["--win", "nsis", "--publish", "always"]);
