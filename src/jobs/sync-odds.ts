import { collectAllBookmakers } from "../bookmakers/registry.js";
import { supabase } from "../db/supabase.js";
import { cleanupOldLogs } from "../services/log-retention.js";
import { errorMessage } from "../utils/errors.js";
import { captureBet365Session } from "./bet365-session.js";

const BET365_REFRESH_TIMEOUT_MS = Number(process.env.BET365_REFRESH_TIMEOUT_MS ?? 100_000);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

async function logBet365RefreshWarning(message: string) {
  const { error } = await supabase.from("collection_logs").insert({
    bookmaker_slug: "bet365",
    level: "warn",
    message: "bet365 session refresh failed before sync:odds",
    context: { error: message }
  });

  if (error) console.warn("[sync] falha ao registrar warning da Bet365:", error.message);
}

async function refreshBet365SessionSafely() {
  try {
    console.log("[sync] atualizando sessao Bet365...");
    await withTimeout(captureBet365Session(), BET365_REFRESH_TIMEOUT_MS, "Bet365 session refresh");
    console.log("[sync] sessao Bet365 atualizada.");
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`[sync] falha ao atualizar sessao Bet365; seguindo com demais coletas: ${message}`);
    await logBet365RefreshWarning(message);
  }
}

try {
  await cleanupOldLogs();
  await refreshBet365SessionSafely();
  const bookmakers = await collectAllBookmakers();
  console.log(JSON.stringify({ bookmakers }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
