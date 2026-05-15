import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { BOOKMAKERS } from "../config/bookmakers.js";
import { env } from "../config/env.js";
import { supabasePublic } from "../db/supabase.js";
import { syncApiFootballFixtures } from "../services/api-football-sync.js";
import { cleanupOldLogs } from "../services/log-retention.js";

const BOOKMAKER_NAME_BY_SLUG = new Map(BOOKMAKERS.map((bookmaker) => [bookmaker.slug, bookmaker.name]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildServer() {
  const app = Fastify({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.x-internal-token",
        "req.headers.x-public-api-token",
        "headers.authorization",
        "headers.x-internal-token",
        "headers.x-public-api-token"
      ]
    }
  });

  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  });
  app.register(cors, {
    origin: corsOrigins(),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-internal-token", "x-public-api-token"],
    credentials: false,
    maxAge: 600
  });
  app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = errorStatusCode(error);
    const message = env.NODE_ENV === "production" && statusCode >= 500 ? "internal server error" : errorMessage(error);
    return reply.code(statusCode).send({ error: message });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;

    if (!request.url.startsWith("/internal/")) return;
    if (!authorizeInternalRequest(request, reply)) return reply;

    return;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || !request.url.startsWith("/v1/")) return;
    if (!authorizePublicApiRequest(request, reply)) return reply;
  });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderSearchPage());
  });

  app.get("/health", async () => ({ ok: true, service: "monitor-odds" }));

  app.get("/v1/status", async () => {
    const [{ data: latestOdd, error: latestOddError }, { data: fixtureSync, error: fixtureSyncError }] = await Promise.all([
      supabasePublic.from("odds").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
      supabasePublic
        .from("fixture_sync_runs")
        .select("date_key,status,fixtures_seen,synced_at")
        .eq("source", "api-football")
        .order("synced_at", { ascending: false })
        .limit(3)
    ]);

    if (latestOddError) throw latestOddError;
    if (fixtureSyncError) throw fixtureSyncError;

    return {
      data: {
        latestOddUpdatedAt: latestOdd?.updated_at ?? null,
        fixtureSyncRuns: fixtureSync ?? [],
        recentSyncLogs: []
      }
    };
  });

  app.get("/v1/fixtures", async (request) => {
    const query = request.query as { search?: string; limit?: string };
    const limit = parseLimit(query.limit, 30, 100);

    let builder = supabasePublic
      .from("fixtures")
      .select("id,api_football_fixture_id,name,home_team,away_team,starts_at,status,round,leagues(name,slug)")
      .gt("starts_at", new Date().toISOString())
      .order("starts_at", { ascending: true })
      .limit(limit);

    const term = sanitizeSearchTerm(query.search);
    if (term) {
      builder = builder.or(`name.ilike.%${term}%,home_team.ilike.%${term}%,away_team.ilike.%${term}%`);
    }

    const { data, error } = await builder;
    if (error) throw error;
    return { data };
  });

  app.get("/v1/odds/search", async (request) => {
    const query = request.query as { q?: string; limit?: string };
    const limit = parseLimit(query.limit, 20, 50);
    const term = sanitizeSearchTerm(query.q);

    if (!term) return { data: [] };

    const { data: fixtures, error: fixtureError } = await supabasePublic
      .from("fixtures")
      .select("id,api_football_fixture_id,name,home_team,away_team,starts_at,status,round,leagues(name,slug)")
      .gt("starts_at", new Date().toISOString())
      .or(`name.ilike.%${term}%,home_team.ilike.%${term}%,away_team.ilike.%${term}%`)
      .order("starts_at", { ascending: true })
      .limit(limit);

    if (fixtureError) throw fixtureError;

    const fixtureIds = (fixtures ?? []).map((fixture) => fixture.id);
    if (!fixtureIds.length) return { data: [] };

    const { data: odds, error: oddsError } = await supabasePublic
      .from("odds")
      .select("fixture_id,bookmaker_slug,market_code,market_name,selection,price,pa_category,confidence_score,updated_at")
      .in("fixture_id", fixtureIds)
      .order("selection", { ascending: true });

    if (oddsError) throw oddsError;

    const oddsByFixture = new Map<string, unknown[]>();
    for (const odd of odds ?? []) {
      const key = odd.fixture_id as string;
      oddsByFixture.set(key, [...(oddsByFixture.get(key) ?? []), odd]);
    }

    return {
      data: (fixtures ?? []).map((fixture) => ({
        ...fixture,
        odds: groupByPa(oddsByFixture.get(fixture.id) ?? [])
      }))
    };
  });

  app.get("/v1/fixtures/:id/odds", async (request, reply) => {
    const params = request.params as { id: string };
    if (!UUID_RE.test(params.id)) {
      return reply.code(400).send({ error: "invalid fixture id" });
    }

    const { data: fixture, error: fixtureError } = await supabasePublic
      .from("fixtures")
      .select("id,api_football_fixture_id,name,home_team,away_team,starts_at,status,round,leagues(name,slug)")
      .eq("id", params.id)
      .single();

    if (fixtureError) throw fixtureError;

    const { data: odds, error: oddsError } = await supabasePublic
      .from("odds")
      .select("bookmaker_slug,market_code,market_name,selection,price,pa_category,confidence_score,updated_at")
      .eq("fixture_id", params.id)
      .order("selection", { ascending: true });

    if (oddsError) throw oddsError;
    return { data: { ...fixture, odds: groupByPa(odds ?? []) } };
  });

  app.post("/internal/collect/:bookmaker", async (request, reply) => {
    if (!authorizeInternalRequest(request, reply)) return;

    const params = request.params as { bookmaker: string };
    const { BOOKMAKER_COLLECTORS } = await import("../bookmakers/registry.js");
    const bookmaker = BOOKMAKER_COLLECTORS.find((item) => item.slug === params.bookmaker);
    if (!bookmaker) {
      return reply.code(404).send({ error: "bookmaker not configured" });
    }

    await cleanupOldLogs();
    const summary = await bookmaker.collect();
    return { data: { bookmaker: bookmaker.slug, summary } };
  });

  app.post("/internal/sync/fixtures", async (request, reply) => {
    if (!authorizeInternalRequest(request, reply)) return;

    await cleanupOldLogs();
    const summary = await syncApiFootballFixtures();
    return { data: summary };
  });

  app.post("/internal/sync/all", async (request, reply) => {
    if (!authorizeInternalRequest(request, reply)) return;

    await cleanupOldLogs();
    const fixtures = await syncApiFootballFixtures();
    const { collectAllBookmakers } = await import("../bookmakers/registry.js");
    const odds = await collectAllBookmakers();
    return { data: { fixtures, odds } };
  });

  return app;
}

function corsOrigins() {
  const configured = env.CORS_ORIGINS.split(",")
    .map((origin) => normalizeCorsOrigin(origin.trim()))
    .filter(Boolean);

  if (configured.length) return configured;
  if (env.NODE_ENV === "production") return false;

  return [`http://localhost:${env.PORT}`, `http://127.0.0.1:${env.PORT}`];
}

function normalizeCorsOrigin(origin: string) {
  if (!origin) return "";

  try {
    return new URL(origin).origin;
  } catch {
    throw new Error(`CORS_ORIGINS contem uma origem invalida: ${origin}`);
  }
}

function errorStatusCode(error: unknown) {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return 500;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "internal server error";
}

function authorizeInternalRequest(request: FastifyRequest, reply: FastifyReply) {
  const expectedToken = env.INTERNAL_COLLECT_TOKEN;
  if (!expectedToken) {
    if (env.NODE_ENV === "production") {
      reply.code(500).send({ error: "internal token is not configured" });
      return false;
    }

    return true;
  }

  const header = request.headers["x-internal-token"];
  const providedToken = Array.isArray(header) ? header[0] : header;
  if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }

  return true;
}

function authorizePublicApiRequest(request: FastifyRequest, reply: FastifyReply) {
  const expectedToken = env.PUBLIC_API_TOKEN;
  if (!expectedToken) {
    if (env.NODE_ENV === "production") {
      reply.code(500).send({ error: "public API token is not configured" });
      return false;
    }

    return true;
  }

  const providedToken = bearerToken(request.headers.authorization) ?? headerToken(request.headers["x-public-api-token"]);
  if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }

  return true;
}

function bearerToken(authorization: string | undefined) {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function headerToken(header: string | string[] | undefined) {
  const token = Array.isArray(header) ? header[0] : header;
  return token?.trim() || undefined;
}

function tokensMatch(providedToken: string, expectedToken: string) {
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function parseLimit(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function sanitizeSearchTerm(value: string | undefined) {
  const term = (value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return term.length >= 2 ? term : "";
}

function groupByPa(odds: unknown[]) {
  const grouped: { COM_PA: unknown[]; SEM_PA: unknown[] } = { COM_PA: [], SEM_PA: [] };

  for (const odd of odds as Array<{ bookmaker_slug?: string; pa_category?: "COM_PA" | "SEM_PA" }>) {
    const item = {
      ...odd,
      bookmaker_name: odd.bookmaker_slug ? (BOOKMAKER_NAME_BY_SLUG.get(odd.bookmaker_slug) ?? odd.bookmaker_slug) : "Casa"
    };

    if (item.pa_category === "COM_PA") grouped.COM_PA.push(item);
    else grouped.SEM_PA.push(item);
  }

  return grouped;
}

function renderSearchPage() {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Odds API - Pesquisa</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111318;
      --panel: #181b22;
      --panel-2: #20242d;
      --line: #303541;
      --text: #f2f5f8;
      --muted: #9aa4b2;
      --accent: #ff5a1f;
      --ok: #54d98c;
      --warn: #ffd166;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1040px, calc(100vw - 32px));
      margin: 36px auto;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 26px;
      letter-spacing: 0;
    }
    .sub {
      margin: 0 0 22px;
      color: var(--muted);
    }
    .search {
      position: relative;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 14px;
    }
    input {
      width: 100%;
      height: 46px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #0f1116;
      color: var(--text);
      padding: 0 14px;
      font-size: 16px;
      outline: none;
    }
    input:focus { border-color: var(--accent); }
    .suggestions {
      position: absolute;
      z-index: 5;
      left: 14px;
      right: 14px;
      top: 68px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      overflow: hidden;
      box-shadow: 0 18px 40px rgba(0,0,0,.35);
    }
    .suggestion {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: transparent;
      color: var(--text);
      padding: 12px 14px;
      text-align: left;
      cursor: pointer;
    }
    .suggestion:last-child { border-bottom: 0; }
    .suggestion:hover { background: #2a303b; }
    .fixture-meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }
    .selected {
      margin-top: 22px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .selected h2 {
      margin: 0 0 4px;
      font-size: 20px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .bucket {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #12151b;
    }
    .bucket header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: #1c2028;
      font-weight: 700;
    }
    .tag {
      border-radius: 999px;
      padding: 3px 8px;
      font-size: 12px;
      background: rgba(255,255,255,.08);
      color: var(--muted);
    }
    .odds-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    .table-wrap {
      overflow-x: hidden;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
      text-align: left;
      vertical-align: middle;
    }
    tr:last-child td { border-bottom: 0; }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      background: #151922;
    }
    th:not(:first-child), td.price-cell {
      text-align: center;
      width: 82px;
    }
    .bookmaker {
      font-size: 16px;
      font-weight: 800;
      margin-bottom: 4px;
    }
    .cache-note {
      color: var(--muted);
      font-size: 12px;
    }
    .price {
      color: var(--ok);
      font-size: 16px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .diff {
      display: block;
      margin-top: 2px;
      color: var(--warn);
      font-size: 11px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .dash {
      color: var(--muted);
      font-weight: 700;
    }
    .odd {
      display: grid;
      grid-template-columns: 84px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 11px 14px;
      border-bottom: 1px solid var(--line);
    }
    .odd:last-child { border-bottom: 0; }
    .sel { color: var(--muted); font-weight: 700; }
    .market { min-width: 0; }
    .market div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .raw { color: var(--muted); font-size: 12px; }
    .price { color: var(--ok); font-size: 18px; font-weight: 800; }
    .empty, .status {
      color: var(--muted);
      padding: 14px;
    }
    @media (max-width: 760px) {
      main { width: min(100vw - 20px, 1040px); margin-top: 18px; }
      .grid { grid-template-columns: 1fr; }
      .odd { grid-template-columns: 64px 1fr auto; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Odds API</h1>
    <p class="sub">Pesquise um evento canonico da API-Football e veja odds por casa, PA e mercado.</p>
    <section class="search">
      <input id="search" autocomplete="off" placeholder="Digite um time ou evento, ex: Flamengo" />
      <div id="suggestions" class="suggestions" hidden></div>
    </section>
    <section id="result"></section>
  </main>
  <script>
    const search = document.querySelector("#search");
    const suggestions = document.querySelector("#suggestions");
    const result = document.querySelector("#result");
    let timer = null;

    const fmtDate = (value) => new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short"
    }).format(new Date(value));

    const labelSelection = (selection) => ({
      HOME: "Casa",
      DRAW: "Empate",
      AWAY: "Fora"
    })[selection] || selection;

    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) {
        suggestions.hidden = true;
        suggestions.innerHTML = "";
        return;
      }
      timer = setTimeout(() => loadSuggestions(q), 220);
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search")) suggestions.hidden = true;
    });

    async function loadSuggestions(q) {
      suggestions.hidden = false;
      suggestions.innerHTML = '<div class="status">Buscando eventos...</div>';
      const response = await fetch("/v1/fixtures?search=" + encodeURIComponent(q) + "&limit=10");
      const payload = await response.json();
      const fixtures = payload.data || [];
      if (!fixtures.length) {
        suggestions.innerHTML = '<div class="status">Nenhum evento encontrado.</div>';
        return;
      }
      suggestions.innerHTML = fixtures.map((fixture) => {
        const league = fixture.leagues?.name || "";
        return '<button class="suggestion" data-id="' + fixture.id + '">' +
          '<span><strong>' + escapeHtml(fixture.name) + '</strong><div class="fixture-meta">' + escapeHtml(league) + ' · ' + fmtDate(fixture.starts_at) + '</div></span>' +
          '<span class="tag">' + escapeHtml(fixture.status || "NS") + '</span>' +
        '</button>';
      }).join("");
      suggestions.querySelectorAll(".suggestion").forEach((button) => {
        button.addEventListener("click", () => selectFixture(button.dataset.id));
      });
    }

    async function selectFixture(id) {
      suggestions.hidden = true;
      result.innerHTML = '<section class="selected"><div class="status">Carregando odds...</div></section>';
      const response = await fetch("/v1/fixtures/" + encodeURIComponent(id) + "/odds");
      const payload = await response.json();
      renderResult(payload.data);
    }

    function renderResult(fixture) {
      const odds = fixture.odds || { COM_PA: [], SEM_PA: [] };
      const lastUpdated = latestOddUpdate([...(odds.COM_PA || []), ...(odds.SEM_PA || [])]);
      result.innerHTML =
        '<section class="selected">' +
          '<h2>' + escapeHtml(fixture.name) + '</h2>' +
          '<div class="fixture-meta">' + escapeHtml(fixture.leagues?.name || "") + ' · ' + fmtDate(fixture.starts_at) + (lastUpdated ? ' · Odds atualizadas ' + fmtDate(lastUpdated) : '') + '</div>' +
          '<div class="grid">' +
            renderBucket("COM PA", odds.COM_PA || []) +
            renderBucket("SEM PA", odds.SEM_PA || []) +
          '</div>' +
        '</section>';
    }

    function renderBucket(title, items) {
      const rows = groupByBookmaker(items);
      return '<div class="bucket">' +
        '<header><span>' + title + '</span></header>' +
        (rows.length ? '<div class="table-wrap">' + renderTable(rows) + '</div>' : '<div class="empty">Nenhuma odd nesta categoria.</div>') +
      '</div>';
    }

    function latestOddUpdate(items) {
      let latest = null;
      for (const odd of items) {
        if (!odd.updated_at) continue;
        const date = new Date(odd.updated_at);
        if (Number.isNaN(date.getTime())) continue;
        if (!latest || date > latest) latest = date;
      }
      return latest;
    }

    function groupByBookmaker(items) {
      const map = new Map();
      for (const odd of items) {
        const marketKey = odd.market_name || odd.market_code || "";
        const key = (odd.bookmaker_slug || "bookmaker") + "::" + marketKey;
        const row = map.get(key) || {
          bookmaker: odd.bookmaker_name || key,
          odds: { HOME: null, DRAW: null, AWAY: null }
        };
        const bucket = row.odds;
        const current = bucket[odd.selection];
        if (!current || new Date(odd.updated_at || 0) >= new Date(current.updated_at || 0)) {
          bucket[odd.selection] = odd;
        }
        map.set(key, row);
      }
      return Array.from(map.values());
    }

    function renderTable(rows) {
      return '<table class="odds-table">' +
        '<thead><tr><th>Casa</th><th>1</th><th>X</th><th>2</th></tr></thead>' +
        '<tbody>' + rows.map(renderBookmakerRow).join("") + '</tbody>' +
      '</table>';
    }

    function renderBookmakerRow(row) {
      return '<tr>' +
        '<td><div class="bookmaker">' + escapeHtml(row.bookmaker) + '</div></td>' +
        renderPriceCell(row.odds.HOME) +
        renderPriceCell(row.odds.DRAW) +
        renderPriceCell(row.odds.AWAY) +
      '</tr>';
    }

    function renderPriceCell(odd) {
      if (!odd) return '<td class="price-cell"><span class="dash">-</span></td>';
      const price = Number(odd.price);
      return '<td class="price-cell"><span class="price">' + price.toFixed(2) + '</span></td>';
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }
  </script>
</body>
</html>`;
}
