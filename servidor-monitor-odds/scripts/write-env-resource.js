import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const envPath = path.join(projectRoot, ".env");
const outputPath = path.join(launcherRoot, "build", "monitor-env.json");

const rawEnv = await readFile(envPath, "utf8");
const parsedEnv = parse(rawEnv);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(parsedEnv, null, 2), "utf8");

console.log(`Env gerado para o pacote: ${outputPath}`);
