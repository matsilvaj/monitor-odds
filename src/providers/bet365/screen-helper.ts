import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BET365_SCREEN_HELPER_PATH = path.resolve("src/providers/bet365-screen-helper.py");

export type Highlight = {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
};

export type ClickResult =
  | { clicked: true; highlight: Highlight }
  | { clicked: false };

function parseHighlightResult(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "{}") return null;
  return JSON.parse(trimmed) as Highlight;
}

async function runScreenHelper(command: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return parseHighlightResult(stdout);
  } catch (caught) {
    const error = caught as Error & { stdout?: string | Buffer };
    const stdout = String(error.stdout ?? "");
    if (stdout.trim() === "{}") return null;
    throw error;
  }
}

export async function clickFindHighlight(): Promise<ClickResult> {
  if (!existsSync(BET365_SCREEN_HELPER_PATH)) {
    throw new Error(`Helper visual da Bet365 nao encontrado: ${BET365_SCREEN_HELPER_PATH}`);
  }

  try {
    const highlight = await runScreenHelper("python", [BET365_SCREEN_HELPER_PATH]);
    return highlight ? { clicked: true, highlight } : { clicked: false };
  } catch (firstError) {
    try {
      const highlight = await runScreenHelper("py", ["-3", BET365_SCREEN_HELPER_PATH]);
      return highlight ? { clicked: true, highlight } : { clicked: false };
    } catch (secondError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`Falha ao clicar destaque visual da Bet365. python: ${firstMessage}; py -3: ${secondMessage}`);
    }
  }
}

