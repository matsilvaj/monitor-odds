import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const envPath = path.join(projectRoot, ".env");
const outputPath = path.join(launcherRoot, "build", "monitor-env.json");
const EXCLUDED_ENV_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_RELEASE_TOKEN"]);

const rawEnv = await readFile(envPath, "utf8");
const parsedEnv = parse(rawEnv);
const bundledEnv = Object.fromEntries(Object.entries(parsedEnv).filter(([key]) => !EXCLUDED_ENV_KEYS.has(key)));

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(bundledEnv, null, 2), "utf8");

console.log(`Env gerado para o pacote: ${outputPath}`);
