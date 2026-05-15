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

    return fixtures;
  }
}
