import { BOOKMAKER_COLLECTORS } from "../bookmakers/registry.js";
import { supabase } from "../db/supabase.js";
import { defaultSyncDateBuckets } from "../services/sync-report.js";
import { installProcessErrorHandlers } from "../utils/process-errors.js";

installProcessErrorHandlers();

const BROWSER_SLUGS = new Set(["meridianbet", "bet365"]);
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

const buckets = defaultSyncDateBuckets();
const todayKey = buckets[0].key;
const tomorrowKey = buckets[1].key;

const fixturesRes = await supabase
  .from("jogos")
  .select("id, date_key, league:campeonatos(name)")
  .in("date_key", [todayKey, tomorrowKey]);

if (fixturesRes.error) { console.error(fixturesRes.error); process.exit(1); }

type FixtureRow = { id: string; date_key: string; league: { name: string } | Array<{ name: string }> | null };
const fixtures = (fixturesRes.data ?? []) as unknown as FixtureRow[];
const fixtureIds = fixtures.map((f) => f.id);

function leagueName(f: FixtureRow): string {
  const l = f.league;
  if (!l) return "Desconhecida";
  return Array.isArray(l) ? (l[0]?.name ?? "Desconhecida") : l.name;
}

const fixtureKeyMap = new Map(fixtures.map((f) => [f.id, f.date_key]));
const fixtureLeagueMap = new Map(fixtures.map((f) => [f.id, leagueName(f)]));

const linksRes = fixtureIds.length
  ? await supabase.rpc("get_fixture_coverage", { fixture_ids: fixtureIds })
  : { data: [], error: null };

if (linksRes.error) { console.error(linksRes.error); process.exit(1); }

type LinkRow = { bookmaker_slug: string; fixture_id: string };
const links = (linksRes.data ?? []) as unknown as LinkRow[];

const apiToday = fixtures.filter((f) => f.date_key === todayKey).length;
const apiTomorrow = fixtures.filter((f) => f.date_key === tomorrowKey).length;
const apiTotal = apiToday + apiTomorrow;

// por casa: fixtures únicos
const bySlug = new Map<string, Set<string>>();
for (const row of links) {
  if (!bySlug.has(row.bookmaker_slug)) bySlug.set(row.bookmaker_slug, new Set());
  bySlug.get(row.bookmaker_slug)!.add(row.fixture_id);
}

// por (casa, liga): contagem
const slugLeague = new Map<string, Map<string, number>>();
for (const row of links) {
  const liga = fixtureLeagueMap.get(row.fixture_id) ?? "Desconhecida";
  if (!slugLeague.has(row.bookmaker_slug)) slugLeague.set(row.bookmaker_slug, new Map());
  const m = slugLeague.get(row.bookmaker_slug)!;
  m.set(liga, (m.get(liga) ?? 0) + 1);
}

// ligas da API com totais
const apiLeagues = new Map<string, number>();
for (const f of fixtures) {
  const name = leagueName(f);
  apiLeagues.set(name, (apiLeagues.get(name) ?? 0) + 1);
}

const allSlugs = BOOKMAKER_COLLECTORS.map((c) => c.slug);

// ─── output ───────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}Status — ${todayKey} / ${tomorrowKey}${R}`);
console.log(`API: ${BOLD}${apiTotal}${R} jogos  (hoje: ${apiToday}, amanhã: ${apiTomorrow})\n`);

console.log(`${BOLD}Ligas na API:${R}`);
for (const [name, count] of [...apiLeagues.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}

for (const slug of allSlugs) {
  const isBrowser = BROWSER_SLUGS.has(slug);
  const fixtures = bySlug.get(slug);
  const total = fixtures?.size ?? 0;
  const pct = apiTotal > 0 ? Math.round((total / apiTotal) * 100) : 0;

  let color = "";
  if (total === 0) color = RED;
  else if (pct < 50) color = YELLOW;
  else if (pct >= 80) color = GREEN;

  const tag = isBrowser ? DIM + " [browser]" + R : "";
  console.log(`\n${color}${BOLD}${slug}${R}${tag} — ${color}${total}${R} jogos`);

  if (total === 0) continue;

  const leagues = slugLeague.get(slug);
  if (!leagues) continue;

  for (const [liga, count] of [...leagues.entries()].sort((a, b) => b[1] - a[1])) {
    const apiCount = apiLeagues.get(liga) ?? 0;
    const missing = apiCount > count;
    console.log(`  ${missing ? YELLOW : ""}${liga}: ${count}/${apiCount}${missing ? R : ""}`);
  }
}

console.log();
