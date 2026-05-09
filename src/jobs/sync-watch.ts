import { collectAllBookmakers } from "../bookmakers/registry.js";
import { supabase } from "../db/supabase.js";
import { cleanupOldLogs } from "../services/log-retention.js";
import { syncApiFootballFixtures } from "../services/api-football-sync.js";
import { errorMessage } from "../utils/errors.js";
import { captureBet365Session } from "./bet365-session.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BET365_REFRESH_TIMEOUT_MS = Number(process.env.BET365_REFRESH_TIMEOUT_MS ?? 100_000);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function nextIntervalMs(minutesToNextFixture: number | null) {
  if (minutesToNextFixture === null) return 60 * 60 * 1000;
  if (minutesToNextFixture <= 3 * 60) return 60 * 1000;
  if (minutesToNextFixture <= 6 * 60) return 15 * 60 * 1000;
  if (minutesToNextFixture <= 24 * 60) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

function formatMs(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return `${minutes}m`;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function getMinutesToNextFixture() {
  const { data, error } = await supabase
    .from("fixtures")
    .select("starts_at")
    .gt("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.starts_at) return null;

  return Math.max(0, (new Date(data.starts_at).getTime() - Date.now()) / 60000);
}

async function logBet365RefreshWarning(message: string) {
  const { error } = await supabase.from("collection_logs").insert({
    bookmaker_slug: "bet365",
    level: "warn",
    message: "bet365 session refresh failed before sync:watch collection",
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

console.log("sync:watch iniciado. Ctrl+C para parar.");
let lastFixtureSyncDate: string | null = null;

while (true) {
  const startedAt = new Date();
  const todayKey = localDateKey(startedAt);
  console.log(`[${startedAt.toISOString()}] sincronizando odds${lastFixtureSyncDate === todayKey ? "" : " e fixtures"}...`);

  console.log("[sync] limpando logs antigos...");
  await cleanupOldLogs();
  console.log(lastFixtureSyncDate === todayKey ? "[sync] fixtures ja sincronizadas hoje; pulando API-Football." : "[sync] sincronizando fixtures via API-Football...");
  const fixtures = lastFixtureSyncDate === todayKey ? { skippedByWatchDate: true } : await syncApiFootballFixtures();
  console.log("[sync] fixtures finalizadas.");
  lastFixtureSyncDate = todayKey;

  await refreshBet365SessionSafely();

  const bookmakers = await collectAllBookmakers({ concurrency: 2, logProgress: true });
  const minutesToNext = await getMinutesToNextFixture();
  const waitMs = nextIntervalMs(minutesToNext);

  console.log(
    JSON.stringify(
      {
        fixtures,
        bookmakers,
        nextFixtureInMinutes: minutesToNext === null ? null : Math.round(minutesToNext),
        nextRunIn: formatMs(waitMs)
      },
      null,
      2
    )
  );

  await sleep(waitMs);
}
