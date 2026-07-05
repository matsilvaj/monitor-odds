import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const envPath = path.join(projectRoot, ".env");
const outputPath = path.join(launcherRoot, "build", "monitor-env.json");
const nodeOutputPath = path.join(launcherRoot, "build", process.platform === "win32" ? "node.exe" : "node");
const EXCLUDED_ENV_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_RELEASE_TOKEN"]);

const rawEnv = await readFile(envPath, "utf8");
const parsedEnv = parse(rawEnv);
const bundledEnv = {
  ...Object.fromEntries(Object.entries(parsedEnv).filter(([key]) => !EXCLUDED_ENV_KEYS.has(key))),
  MONITOR_PROJECT_ROOT: projectRoot
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(bundledEnv, null, 2), "utf8");
await copyFile(process.execPath, nodeOutputPath);

console.log(`Env gerado para o pacote: ${outputPath}`);
console.log(`Node gerado para o pacote: ${nodeOutputPath}`);
