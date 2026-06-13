import type { SportingbetBookmakerConfig } from "../config/bookmakers.js";
import { httpClient } from "../utils/http-client.js";

export type SportingbetOption = {
  id: number;
  name?: { value?: string };
  status?: string;
  price?: { odds?: number };
  parameters?: {
    optionTypes?: string[];
    fixtureParticipant?: number;
  };
  [key: string]: unknown;
};

export type SportingbetMarket = {
  id: number;
  name?: { value?: string };
  status?: string;
  options?: SportingbetOption[];
  parameters?: Array<{ key: string; value: string }>;
  isMain?: boolean;
  [key: string]: unknown;
};

export type SportingbetFixture = {
  id: string;
  sourceId?: number;
  name?: { value?: string };
  stage?: string;
  startDate: string;
  participants?: Array<{
    id: number;
    name?: { value?: string };
    properties?: { type?: string };
  }>;
  optionMarkets?: SportingbetMarket[];
  [key: string]: unknown;
};

function collectFixtureCandidates(value: unknown, output: SportingbetFixture[] = [], seen = new Set<string>()) {
  if (!value || typeof value !== "object") return output;

  if (Array.isArray(value)) {
    for (const item of value) collectFixtureCandidates(item, output, seen);
    return output;
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  const startDate = record.startDate;
  const looksLikeFixture = (typeof id === "string" || typeof id === "number") && typeof startDate === "string" && (
    Array.isArray(record.optionMarkets) ||
    Array.isArray(record.participants) ||
    typeof record.name === "object"
  );

  if (looksLikeFixture) {
    const fixture = { ...record, id: String(id) } as SportingbetFixture;
    if (!seen.has(fixture.id)) {
      seen.add(fixture.id);
      output.push(fixture);
    }
  }

  for (const child of Object.values(record)) {
    collectFixtureCandidates(child, output, seen);
  }

  return output;
}

export class SportingbetClient {
  private readonly headers: Record<string, string>;

  constructor(private readonly config: SportingbetBookmakerConfig) {
    this.headers = {
      accept: "application/json",
      "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      referer: config.referer
    };
  }

  private async getFixturesPage(skip: number) {
    const params = new URLSearchParams({
      "x-bwin-accessid": this.config.accessId,
      lang: "pt-br",
      country: "BR",
      userCountry: "BR",
      fixtureTypes: "Standard",
      state: "Latest",
      offerMapping: "Filtered",
      offerCategories: "Gridable",
      fixtureCategories: "Gridable,NonGridable,Other",
      sportIds: "4",
      isPriceBoost: "false",
      statisticsModes: "None",
      skip: String(skip),
      take: String(this.config.take),
      sortBy: "Tags"
    });

    const data = await httpClient<{ fixtures?: SportingbetFixture[] }>({
      url: new URL(`cds-api/bettingoffer/fixtures?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine
    });
    return Array.isArray(data.fixtures) ? data.fixtures : [];
  }

  private async getRegionalFixtures() {
    const params = new URLSearchParams({
      "x-bwin-accessid": this.config.accessId,
      lang: "pt-br",
      country: "BR",
      userCountry: "BR",
      sportIds: "4",
      fixtureTypes: "Standard",
      state: "Latest",
      offerMapping: "Filtered",
      offerCategories: "Gridable",
      fixtureCategories: "Gridable,NonGridable,Other",
      statisticsModes: "None",
      sortBy: "Tags"
    });

    const data = await httpClient<unknown>({
      url: new URL(`cds-api/offer-grouping/v2/fixture-view/regional?${params}`, this.config.baseUrl),
      headers: this.headers,
      referer: this.config.referer,
      engine: this.config.engine,
      timeoutMs: 20_000,
      maxRetries: 1
    });

    return collectFixtureCandidates(data);
  }

  async getFixtures() {
    const fixtures: SportingbetFixture[] = [];
    const seen = new Set<string>();
    const maxPages = 10;

    for (let page = 0; page < maxPages; page += 1) {
      const pageFixtures = await this.getFixturesPage(page * this.config.take);
      if (!pageFixtures.length) break;

      for (const fixture of pageFixtures) {
        if (seen.has(fixture.id)) continue;
        seen.add(fixture.id);
        fixtures.push(fixture);
      }

      if (pageFixtures.length < this.config.take) break;
    }

    const regionalFixtures = await this.getRegionalFixtures().catch(() => []);
    for (const fixture of regionalFixtures) {
      if (seen.has(fixture.id)) continue;
      seen.add(fixture.id);
      fixtures.push(fixture);
    }

    return fixtures;
  }
}
