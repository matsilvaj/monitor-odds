import { BOOKMAKER_COLLECTORS } from "../bookmakers/registry.js";
import { supabase } from "../db/supabase.js";
import { defaultSyncDateBuckets } from "../services/sync-report.js";
import { installProcessErrorHandlers } from "../utils/process-errors.js";

installProcessErrorHandlers();

const BROWSER_SLUGS = new Set(["meridianbet", "bet365"]);

const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

const W_NAME = 17;
const W_NUM = 7;
const SEP_LEN = W_NAME + W_NUM * 3;
const SEP = "─".repeat(SEP_LEN);

const buckets = defaultSyncDateBuckets();
const todayKey = buckets[0].key;
const tomorrowKey = buckets[1].key;

const [fixturesRes, oddsRes] = await Promise.all([
  supabase
    .from("jogos")
    .select("date_key, liga:ligas(nome)")
    .in("date_key", [todayKey, tomorrowKey]),
  supabase
    .from("cotacoes")
    .select("bookmaker_slug, fixture_id, date_key")
    .in("date_key", [todayKey, tomorrowKey])
]);

if (fixturesRes.error) throw fixturesRes.error;
if (oddsRes.error) throw oddsRes.error;

const fixtures = (fixturesRes.data ?? []) as unknown as Array<{ date_key: string; liga: { nome: string } | null }>;
const apiToday = fixtures.filter((f) => f.date_key === todayKey).length;
const apiTomorrow = fixtures.filter((f) => f.date_key === tomorrowKey).length;
const apiTotal = apiToday + apiTomorrow;

// ─── tabela de casas ──────────────────────────────────────────────────────────

const todaySets = new Map<string, Set<string>>();
const tomorrowSets = new Map<string, Set<string>>();
for (const row of (oddsRes.data ?? []) as Array<{ bookmaker_slug: string; fixture_id: string; date_key: string }>) {
  const map = row.date_key === todayKey ? todaySets : tomorrowSets;
  if (!map.has(row.bookmaker_slug)) map.set(row.bookmaker_slug, new Set());
  map.get(row.bookmaker_slug)!.add(row.fixture_id);
}

const buildRow = (slug: string) => {
  const t = todaySets.get(slug)?.size ?? 0;
  const tm = tomorrowSets.get(slug)?.size ?? 0;
  const total = t + tm;
  let color = "";
  if (apiTotal > 0) {
    if (total === 0) color = RED;
    else if (total < apiTotal * 0.5) color = YELLOW;
  }
  const line = slug.padEnd(W_NAME) + String(t).padStart(W_NUM) + String(tm).padStart(W_NUM) + String(total).padStart(W_NUM);
  return color ? color + line + R : line;
};

const fastSlugs = BOOKMAKER_COLLECTORS.filter((c) => !BROWSER_SLUGS.has(c.slug)).map((c) => c.slug);
const browserSlugs = BOOKMAKER_COLLECTORS.filter((c) => BROWSER_SLUGS.has(c.slug)).map((c) => c.slug);

const header = " ".repeat(W_NAME) + "Hoje".padStart(W_NUM) + "Amanhã".padStart(W_NUM) + "Total".padStart(W_NUM);
const apiRow = "API".padEnd(W_NAME) + String(apiToday).padStart(W_NUM) + String(apiTomorrow).padStart(W_NUM) + String(apiTotal).padStart(W_NUM);

console.log(`\n${BOLD}Casas de apostas${R}`);
console.log(SEP);
console.log(header);
console.log(apiRow);
console.log(SEP);
for (const slug of fastSlugs) console.log(buildRow(slug));
if (browserSlugs.length) {
  console.log(`${DIM}${"─".repeat(SEP_LEN)}${R}`);
  for (const slug of browserSlugs) console.log(buildRow(slug));
}
console.log(SEP);

// ─── tabela por liga ──────────────────────────────────────────────────────────

const leagueToday = new Map<string, number>();
const leagueTomorrow = new Map<string, number>();
for (const f of fixtures) {
  const nome = f.liga?.nome ?? "Desconhecida";
  if (f.date_key === todayKey) leagueToday.set(nome, (leagueToday.get(nome) ?? 0) + 1);
  else leagueTomorrow.set(nome, (leagueTomorrow.get(nome) ?? 0) + 1);
}
const allLeagues = [...new Set([...leagueToday.keys(), ...leagueTomorrow.keys()])].sort((a, b) => {
  const ta = (leagueToday.get(a) ?? 0) + (leagueTomorrow.get(a) ?? 0);
  const tb = (leagueToday.get(b) ?? 0) + (leagueTomorrow.get(b) ?? 0);
  return tb - ta;
});

const W_LEAGUE = 30;
const SEP_L = W_LEAGUE + W_NUM * 3;
const SEPL = "─".repeat(SEP_L);
const headerL = " ".repeat(W_LEAGUE) + "Hoje".padStart(W_NUM) + "Amanhã".padStart(W_NUM) + "Total".padStart(W_NUM);

console.log(`\n${BOLD}Jogos por liga${R}`);
console.log(SEPL);
console.log(headerL);
console.log(SEPL);
for (const liga of allLeagues) {
  const t = leagueToday.get(liga) ?? 0;
  const tm = leagueTomorrow.get(liga) ?? 0;
  const total = t + tm;
  const name = liga.length > W_LEAGUE - 1 ? liga.slice(0, W_LEAGUE - 2) + "…" : liga;
  console.log(name.padEnd(W_LEAGUE) + String(t).padStart(W_NUM) + String(tm).padStart(W_NUM) + String(total).padStart(W_NUM));
}
console.log(SEPL);
console.log();
