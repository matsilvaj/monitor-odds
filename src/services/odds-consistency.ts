import { supabase } from "../db/supabase.js";

const MARKET_CODE = "1X2";
// Minimo de casas com odds no mesmo grupo para o consenso ser confiavel.
const MIN_BOOKMAKERS = 4;
// Desvio maximo tolerado em pontos percentuais de probabilidade implicita.
const MAX_DEVIATION_PP = 20;
// Tentativas de re-link antes de suprimir a casa naquele jogo em definitivo.
const MAX_RELINK_ATTEMPTS = 3;
const SELECT_BATCH_SIZE = 500;

type ConsistencyOddRow = {
  fixture_id: string;
  bookmaker_slug: string;
  selection: string;
  price: number;
  pa_category: string;
};

type BlockRow = {
  id: string;
  fixture_id: string;
  bookmaker_slug: string;
  scope: "EVENTO" | "PARCIAL";
  pa_category: string;
  attempts: number;
  blocked: boolean;
  rejected_event_ids: string[];
};

export type OddsBlock = Pick<BlockRow, "fixture_id" | "scope" | "pa_category" | "blocked" | "rejected_event_ids">;

export type ConsistencySweepSummary = {
  fixturesChecked: number;
  eventMismatches: number;
  partialMismatches: number;
  oddsDeleted: number;
  linksDeleted: number;
};

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function groupKey(paCategory: string, selection: string) {
  return `${paCategory}:${selection}`;
}

/**
 * Bloqueios ativos de uma casa, usados para impedir que odds/links reprovados
 * voltem ao banco na proxima coleta.
 */
export async function fetchOddsBlocks(bookmakerSlug: string): Promise<OddsBlock[]> {
  const { data, error } = await supabase
    .from("bloqueios_cotacoes")
    .select("fixture_id,scope,pa_category,blocked,rejected_event_ids")
    .eq("bookmaker_slug", bookmakerSlug);

  if (error) throw error;
  return (data ?? []) as unknown as OddsBlock[];
}

async function fetchUpcomingFixtureIds() {
  const { data, error } = await supabase
    .from("jogos")
    .select("id")
    .gt("starts_at", new Date().toISOString());

  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function fetchOddsForFixtures(fixtureIds: string[]) {
  const rows: ConsistencyOddRow[] = [];

  for (const fixtureIdBatch of chunks(fixtureIds, SELECT_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from("cotacoes")
      .select("fixture_id,bookmaker_slug,selection,price,pa_category")
      .eq("market_code", MARKET_CODE)
      .in("fixture_id", fixtureIdBatch);

    if (error) throw error;
    rows.push(...((data ?? []) as unknown as ConsistencyOddRow[]));
  }

  return rows;
}

type Mismatch =
  | { scope: "EVENTO"; fixtureId: string; bookmakerSlug: string; reason: string }
  | { scope: "PARCIAL"; fixtureId: string; bookmakerSlug: string; paCategory: string; reason: string };

/**
 * Compara cada casa contra a mediana das demais (mesma selecao e mesmo pa_category)
 * e classifica os desvios acima do limite como evento errado ou erro parcial de coleta.
 */
export function detectMismatches(odds: ConsistencyOddRow[]): Mismatch[] {
  const byFixture = new Map<string, ConsistencyOddRow[]>();
  for (const odd of odds) {
    if (!Number.isFinite(odd.price) || odd.price <= 1) continue;
    const list = byFixture.get(odd.fixture_id) ?? [];
    list.push(odd);
    byFixture.set(odd.fixture_id, list);
  }

  const mismatches: Mismatch[] = [];

  for (const [fixtureId, fixtureOdds] of byFixture) {
    const distinctBookmakers = new Set(fixtureOdds.map((odd) => odd.bookmaker_slug));
    if (distinctBookmakers.size < MIN_BOOKMAKERS) continue;

    // grupo = mesma selecao + mesmo pa_category; COM_PA e SEM_PA nunca se comparam entre si.
    const groups = new Map<string, Map<string, number>>();
    for (const odd of fixtureOdds) {
      const key = groupKey(odd.pa_category, odd.selection);
      const group = groups.get(key) ?? new Map<string, number>();
      // mantem a maior odd quando a casa repete a mesma selecao
      const implied = 1 / odd.price;
      const current = group.get(odd.bookmaker_slug);
      if (current === undefined || implied < current) group.set(odd.bookmaker_slug, implied);
      groups.set(key, group);
    }

    // por casa e por pa_category: selecoes avaliadas e selecoes que destoaram
    const evaluated = new Map<string, Map<string, Set<string>>>();
    const deviating = new Map<string, Map<string, Map<string, number>>>();

    for (const [key, group] of groups) {
      if (group.size < MIN_BOOKMAKERS) continue;
      const [paCategory, selection] = key.split(":") as [string, string];

      for (const [bookmakerSlug, implied] of group) {
        const others = [...group.entries()].filter(([slug]) => slug !== bookmakerSlug).map(([, value]) => value);
        if (others.length < MIN_BOOKMAKERS - 1) continue;

        const evaluatedByPa = evaluated.get(bookmakerSlug) ?? new Map<string, Set<string>>();
        const evaluatedSelections = evaluatedByPa.get(paCategory) ?? new Set<string>();
        evaluatedSelections.add(selection);
        evaluatedByPa.set(paCategory, evaluatedSelections);
        evaluated.set(bookmakerSlug, evaluatedByPa);

        const deviationPp = Math.abs(implied - median(others)) * 100;
        if (deviationPp <= MAX_DEVIATION_PP) continue;

        const deviatingByPa = deviating.get(bookmakerSlug) ?? new Map<string, Map<string, number>>();
        const deviatingSelections = deviatingByPa.get(paCategory) ?? new Map<string, number>();
        deviatingSelections.set(selection, deviationPp);
        deviatingByPa.set(paCategory, deviatingSelections);
        deviating.set(bookmakerSlug, deviatingByPa);
      }
    }

    for (const [bookmakerSlug, deviatingByPa] of deviating) {
      const evaluatedByPa = evaluated.get(bookmakerSlug);
      if (!evaluatedByPa?.size) continue;

      // Um pa_category conta como corrompido quando 2+ selecoes destoam. Evento errado
      // desloca varias pernas; falha de parsing costuma atingir apenas uma.
      const corruptedPaCategories = new Set(
        [...deviatingByPa.entries()]
          .filter(([paCategory, selections]) => {
            const evaluatedCount = evaluatedByPa.get(paCategory)?.size ?? 0;
            return selections.size >= Math.min(2, evaluatedCount);
          })
          .map(([paCategory]) => paCategory)
      );

      const worstPp = Math.max(...[...deviatingByPa.values()].flatMap((selections) => [...selections.values()])).toFixed(1);

      // todos os pa_category avaliados da casa estao corrompidos => evento errado linkado
      if (corruptedPaCategories.size > 0 && corruptedPaCategories.size === evaluatedByPa.size) {
        mismatches.push({
          scope: "EVENTO",
          fixtureId,
          bookmakerSlug,
          reason: `todos os mercados fora do consenso (max ${worstPp}pp)`
        });
        continue;
      }

      // apenas parte dos mercados destoa => erro de coleta naquele pa_category
      for (const [paCategory, selections] of deviatingByPa) {
        const paWorstPp = Math.max(...selections.values()).toFixed(1);
        mismatches.push({
          scope: "PARCIAL",
          fixtureId,
          bookmakerSlug,
          paCategory,
          reason: `${paCategory} fora do consenso (max ${paWorstPp}pp)`
        });
      }
    }
  }

  return mismatches;
}

async function upsertBlock(input: {
  fixtureId: string;
  bookmakerSlug: string;
  scope: "EVENTO" | "PARCIAL";
  paCategory: string;
  attempts: number;
  blocked: boolean;
  rejectedEventIds: string[];
  reason: string;
}) {
  const { error } = await supabase.from("bloqueios_cotacoes").upsert(
    {
      fixture_id: input.fixtureId,
      bookmaker_slug: input.bookmakerSlug,
      scope: input.scope,
      pa_category: input.paCategory,
      attempts: input.attempts,
      blocked: input.blocked,
      rejected_event_ids: input.rejectedEventIds,
      last_reason: input.reason,
      last_detected_at: new Date().toISOString()
    },
    { onConflict: "fixture_id,bookmaker_slug,scope,pa_category" }
  );

  if (error) throw error;
}

/**
 * Varredura de consistencia. Deve rodar apos um ciclo completo de todas as casas,
 * quando o banco ja tem odds suficientes para formar consenso.
 */
export async function sweepInconsistentOdds(options: { logProgress?: boolean } = {}): Promise<ConsistencySweepSummary> {
  const logProgress = options.logProgress ?? true;
  const summary: ConsistencySweepSummary = {
    fixturesChecked: 0,
    eventMismatches: 0,
    partialMismatches: 0,
    oddsDeleted: 0,
    linksDeleted: 0
  };

  const fixtureIds = await fetchUpcomingFixtureIds();
  if (!fixtureIds.length) return summary;

  const odds = await fetchOddsForFixtures(fixtureIds);
  summary.fixturesChecked = new Set(odds.map((odd) => odd.fixture_id)).size;

  const mismatches = detectMismatches(odds);
  if (!mismatches.length) {
    if (logProgress) console.log("[consistencia] Nenhuma odd fora do consenso.");
    return summary;
  }

  const { data: existingBlocksData, error: existingBlocksError } = await supabase
    .from("bloqueios_cotacoes")
    .select("id,fixture_id,bookmaker_slug,scope,pa_category,attempts,blocked,rejected_event_ids")
    .in("fixture_id", [...new Set(mismatches.map((mismatch) => mismatch.fixtureId))]);

  if (existingBlocksError) throw existingBlocksError;

  const existingBlocks = new Map(
    ((existingBlocksData ?? []) as unknown as BlockRow[]).map((row) => [
      `${row.fixture_id}:${row.bookmaker_slug}:${row.scope}:${row.pa_category}`,
      row
    ])
  );

  for (const mismatch of mismatches) {
    const paCategory = mismatch.scope === "PARCIAL" ? mismatch.paCategory : "";
    const blockKey = `${mismatch.fixtureId}:${mismatch.bookmakerSlug}:${mismatch.scope}:${paCategory}`;
    const existing = existingBlocks.get(blockKey);

    if (mismatch.scope === "PARCIAL") {
      summary.partialMismatches += 1;

      const deleted = await supabase
        .from("cotacoes")
        .delete({ count: "exact" })
        .eq("fixture_id", mismatch.fixtureId)
        .eq("bookmaker_slug", mismatch.bookmakerSlug)
        .eq("market_code", MARKET_CODE)
        .eq("pa_category", mismatch.paCategory);

      if (deleted.error) throw deleted.error;
      summary.oddsDeleted += deleted.count ?? 0;

      await upsertBlock({
        fixtureId: mismatch.fixtureId,
        bookmakerSlug: mismatch.bookmakerSlug,
        scope: "PARCIAL",
        paCategory: mismatch.paCategory,
        attempts: existing?.attempts ?? 0,
        blocked: true,
        rejectedEventIds: existing?.rejected_event_ids ?? [],
        reason: mismatch.reason
      });

      if (logProgress) {
        console.log(`[consistencia] ${mismatch.bookmakerSlug} / ${mismatch.fixtureId}: ${mismatch.reason} — odds ${mismatch.paCategory} removidas.`);
      }

      continue;
    }

    summary.eventMismatches += 1;

    const { data: linkData, error: linkError } = await supabase
      .from("links_eventos")
      .select("id,external_event_id")
      .eq("fixture_id", mismatch.fixtureId)
      .eq("bookmaker_slug", mismatch.bookmakerSlug);

    if (linkError) throw linkError;

    const links = (linkData ?? []) as unknown as Array<{ id: string; external_event_id: string | number }>;
    const attempts = (existing?.attempts ?? 0) + 1;
    const exhausted = attempts > MAX_RELINK_ATTEMPTS;
    const rejectedEventIds = [
      ...new Set([...(existing?.rejected_event_ids ?? []), ...links.map((link) => String(link.external_event_id))])
    ];

    const deletedOdds = await supabase
      .from("cotacoes")
      .delete({ count: "exact" })
      .eq("fixture_id", mismatch.fixtureId)
      .eq("bookmaker_slug", mismatch.bookmakerSlug);

    if (deletedOdds.error) throw deletedOdds.error;
    summary.oddsDeleted += deletedOdds.count ?? 0;

    if (links.length) {
      const deletedLinks = await supabase
        .from("links_eventos")
        .delete({ count: "exact" })
        .in("id", links.map((link) => link.id));

      if (deletedLinks.error) throw deletedLinks.error;
      summary.linksDeleted += deletedLinks.count ?? 0;
    }

    await upsertBlock({
      fixtureId: mismatch.fixtureId,
      bookmakerSlug: mismatch.bookmakerSlug,
      scope: "EVENTO",
      paCategory: "",
      attempts: Math.min(attempts, MAX_RELINK_ATTEMPTS + 1),
      blocked: exhausted,
      rejectedEventIds,
      reason: mismatch.reason
    });

    if (logProgress) {
      const tail = exhausted
        ? "tentativas esgotadas — casa suprimida neste jogo ate o evento sair do banco."
        : `tentativa ${attempts}/${MAX_RELINK_ATTEMPTS} — link removido para nova busca.`;
      console.log(`[consistencia] ${mismatch.bookmakerSlug} / ${mismatch.fixtureId}: ${mismatch.reason} — ${tail}`);
    }
  }

  if (logProgress) {
    console.log(
      `[consistencia] ${summary.eventMismatches} evento(s) errado(s), ${summary.partialMismatches} erro(s) parcial(is); ${summary.oddsDeleted} odd(s) e ${summary.linksDeleted} link(s) removidos.`
    );
  }

  return summary;
}
