import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const envPath = path.join(projectRoot, ".env");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
  throw new Error("GH_TOKEN nao encontrado. Configure GH_TOKEN no .env ou no ambiente do terminal antes de publicar.");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const electronBuilderCommand = path.join(launcherRoot, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");

await run(npmCommand, ["--prefix", "..", "run", "build"]);
await run(process.execPath, ["scripts/write-env-resource.js"]);
await run(electronBuilderCommand, ["--win", "nsis", "--publish", "always"]);
