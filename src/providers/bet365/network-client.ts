import { chromium, type Browser, type BrowserContext, type Page, type WebSocket } from "playwright-core";
import { nationalTeamAliases } from "../../domain/matching/team-aliases.js";
import { matchingTokens, teamNameSearchPatterns } from "../../domain/matching/text-similarity.js";
import type { Bet365DomMarket, Logger } from "./types.js";

export type Bet365NetworkCapture = {
  sourceUrl: string;
  payloads: string[];
  domMarkets: Bet365DomMarket[];
  clickedTeam: string | null;
  pageText: string;
  pageState: Bet365PageStateName;
};

export type Bet365ClickTarget = {
  homeTeam: string | null;
  awayTeam: string | null;
};

export type Bet365NetworkTabSession = {
  collectEventOdds(url: string, waitMs: number, target?: Bet365ClickTarget | null, clickEvent?: boolean, forceNavigate?: boolean): Promise<Bet365NetworkCapture>;
};

type Bet365PageStateName = "HOME" | "LEAGUE" | "EVENT" | "WRONG_EVENT" | "EVENT_READY" | "EVENT_LOADING" | "UNKNOWN";

type Bet365PageState = {
  name: Bet365PageStateName;
  sourceUrl: string;
  pageText: string;
  domMarkets: Bet365DomMarket[];
  hasTargetFixture: boolean;
  isEventUrl: boolean;
};

function payloadToString(payload: string | Buffer) {
  return typeof payload === "string" ? payload : payload.toString("utf8");
}

function looksLikeBet365Payload(payload: string) {
  if (!payload) return false;
  if (payload.includes("OVInPlay")) return true;
  if (payload.includes("|EV;") || payload.includes("|MA;") || payload.includes("|PA;")) return true;
  return payload.length > 100 && payload.includes("|") && payload.includes(";");
}

function isBet365EventUrl(url: string | null | undefined) {
  return /\/E\d+\/F/i.test(String(url ?? ""));
}

function targetTeamNames(target: Bet365ClickTarget | null | undefined) {
  return [target?.homeTeam, target?.awayTeam].filter((team): team is string => Boolean(team?.trim()));
}

function withAmpersandAliases(value: string) {
  return [value, value.replace(/\band\b/gi, "&"), value.replace(/\s*&\s*/g, " and ")].filter(Boolean);
}

function targetTeamAliases(target: Bet365ClickTarget | null | undefined) {
  return targetTeamNames(target).map((team) => [...new Set(nationalTeamAliases(team).flatMap(withAmpersandAliases))]);
}

function teamTokenGroups(team: string | null | undefined) {
  if (!team?.trim()) return [];
  const groups = nationalTeamAliases(team)
    .flatMap(withAmpersandAliases)
    .map((alias) => matchingTokens(alias).filter((token) => token.length > 1))
    .filter((tokens) => tokens.length > 0);

  return [...new Map(groups.map((tokens) => [tokens.join(":"), tokens])).values()];
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.,]+/g, " ")
    .trim();
}

function textMatchesTokenGroups(rawText: string, groups: string[][]) {
  const normalized = normalizeText(rawText);
  if (!normalized || !groups.length) return false;
  const tokenSet = new Set(normalized.split(/\s+/).filter(Boolean));
  return groups.some((group) =>
    group.every((token) => (token.length <= 3 ? tokenSet.has(token) : normalized.includes(token)))
  );
}

function textHasFixturePair(rawText: string, target: Bet365ClickTarget | null | undefined) {
  return textMatchesTokenGroups(rawText, teamTokenGroups(target?.homeTeam)) && textMatchesTokenGroups(rawText, teamTokenGroups(target?.awayTeam));
}

function pageLooksLikeHome(rawText: string) {
  const normalized = normalizeText(rawText);
  return /\b(?:bet365|todos os esportes|ao vivo|login|registre se|promocoes|inicio|cassino)\b/i.test(normalized);
}

function pageLooksLikeLeague(rawText: string) {
  const normalized = normalizeText(rawText);
  return /\b(?:matches|full time result|resultado final|pagamento antecipado|early payout|acum aumentado|aposta aumentada|bet builder)\b/i.test(normalized);
}

function pageStateIsTargetEvent(state: Bet365PageState | null | undefined): state is Bet365PageState & { name: "EVENT_READY" | "EVENT_LOADING" } {
  return state?.name === "EVENT_READY" || state?.name === "EVENT_LOADING";
}

function parseVisibleMoneylineMarkets(rawTexts: string[], target: Bet365ClickTarget | null | undefined): Bet365DomMarket[] {
  const markets: Bet365DomMarket[] = [];
  const teams = targetTeamNames(target);
  const aliasesByTeam = targetTeamAliases(target);
  const marketBlocks = rawTexts.flatMap((rawText) => {
    const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const blocks: string[][] = [];
    for (const line of lines) {
      const normalized = normalizeText(line);
      const isHeader = normalized.includes("full time result") || normalized.includes("resultado final");
      if (isHeader || !blocks.length) blocks.push([]);
      blocks[blocks.length - 1].push(line);
    }
    return blocks.map((block) => block.join("\n"));
  });

  const priceAfterLabel = (rawText: string, label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literalMatch = rawText.match(new RegExp(`${escaped}[\\s\\S]{0,60}?([1-9]\\d{0,2}[.,]\\d{2,3})\\b`, "i"));
    if (literalMatch) return Number(literalMatch[1].replace(",", "."));

    const match = teamNameSearchPatterns(label)
      .map((pattern) => rawText.match(new RegExp(`${pattern.source}[\\s\\S]{0,60}?([1-9]\\d{0,2}[.,]\\d{2,3})\\b`, "i")))
      .find((result): result is RegExpMatchArray => Boolean(result));
    return match ? Number(match[1].replace(",", ".")) : null;
  };

  for (const rawText of marketBlocks) {
    const lines = rawText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const normalized = normalizeText(rawText);
    if (!normalized.includes("full time result") && !normalized.includes("resultado final")) continue;

    const paCategory =
      normalized.includes("pagamento antecipado") || normalized.includes("early payout")
        ? "COM_PA"
        : normalized.includes("enhanced prices") || normalized.includes("precos ajustados")
          ? "SEM_PA"
          : "SEM_PA";

    const selections = teams
      .map((team, index) => {
        const price = aliasesByTeam[index]?.map((alias) => priceAfterLabel(rawText, alias)).find((value): value is number => value != null) ?? null;
        return price ? { label: team, price } : null;
      })
      .filter((selection): selection is { label: string; price: number } => Boolean(selection));

    const drawLabel = normalized.includes("empate") ? "Empate" : "Draw";
    const drawPrice = priceAfterLabel(rawText, drawLabel) ?? priceAfterLabel(rawText, "X");
    if (drawPrice) {
      selections.splice(1, 0, { label: drawLabel, price: drawPrice });
    }

    if (selections.length < 3) continue;
    markets.push({
      marketName: lines.find((line) => normalizeText(line).includes("full time result") || normalizeText(line).includes("resultado final")) ?? "Full Time Result",
      paCategory,
      rawText,
      selections: selections.slice(0, 3)
    });
  }

  const unique = new Map<string, Bet365DomMarket>();
  for (const market of markets) {
    const key = `${market.paCategory}:${market.selections.map((selection) => selection.price).join("/")}`;
    if (!unique.has(key)) unique.set(key, market);
  }
  const values = [...unique.values()];
  const comPa = values.find((market) => market.paCategory === "COM_PA");
  const semPa = values.find((market) => market.paCategory === "SEM_PA");
  return [comPa, semPa].filter((market): market is Bet365DomMarket => Boolean(market));
}

class Bet365PageController {
  constructor(
    private readonly page: Page,
    private readonly logger?: Logger,
    private readonly closePageOnClose = false
  ) {}

  async navigate(url: string, timeoutMs: number) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(timeoutMs, 10_000) });
  }

  async currentUrl() {
    if (!this.page) return "";
    return this.page.url();
  }

  private async pageBodyText(timeout = 2_000) {
    if (!this.page) return "";
    return this.page.locator("body").innerText({ timeout }).catch(() => "");
  }

  private classifyPageState(sourceUrl: string, pageText: string, target: Bet365ClickTarget | null | undefined): Bet365PageState {
    const isEventUrl = isBet365EventUrl(sourceUrl);
    const hasTargetFixture = target?.homeTeam && target.awayTeam ? textHasFixturePair(pageText, target) : false;
    const domMarkets = target ? parseVisibleMoneylineMarkets([pageText], target) : [];
    let name: Bet365PageStateName = "UNKNOWN";

    if (isEventUrl && hasTargetFixture && domMarkets.length) name = "EVENT_READY";
    else if (isEventUrl && hasTargetFixture) name = "EVENT_LOADING";
    else if (isEventUrl && target && pageText.trim().length > 200) name = "WRONG_EVENT";
    else if (isEventUrl) name = "EVENT";
    else if (hasTargetFixture) name = "LEAGUE";
    else if (pageLooksLikeLeague(pageText)) name = "LEAGUE";
    else if (pageLooksLikeHome(pageText)) name = "HOME";

    return {
      name,
      sourceUrl,
      pageText,
      domMarkets,
      hasTargetFixture: Boolean(hasTargetFixture),
      isEventUrl
    };
  }

  private async inspectCurrentPage(target: Bet365ClickTarget | null | undefined, timeout = 2_000) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const sourceUrl = this.page.url();
    const pageText = await this.page.locator("body").innerText({ timeout }).catch(() => "");
    return this.classifyPageState(sourceUrl, pageText, target);
  }

  private async waitForPageState(
    target: Bet365ClickTarget | null | undefined,
    accepts: (state: Bet365PageState) => boolean,
    timeoutMs: number
  ) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const deadline = Date.now() + timeoutMs;
    let latest = await this.inspectCurrentPage(target, 1_500);

    while (Date.now() < deadline) {
      if (accepts(latest)) return latest;
      await this.page.waitForTimeout(500);
      latest = await this.inspectCurrentPage(target, 1_500);
    }

    return latest;
  }

  private async clickOpenedEvent(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) return false;

    await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
    const state = await this.waitForPageState(
      target,
      (candidate) => pageStateIsTargetEvent(candidate) || (candidate.isEventUrl && !target),
      5_000
    );

    return target ? pageStateIsTargetEvent(state) : state.isEventUrl;
  }

  private async restoreAfterRejectedClick(sourceUrl: string) {
    if (!this.page) return;
    const currentUrl = this.page.url();
    if (currentUrl === sourceUrl) return;
    if (isBet365EventUrl(currentUrl) || currentUrl.includes("bet365")) {
      await this.page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => undefined);
      await this.page.waitForTimeout(800);
    }
  }

  private async scrollSearchViewport(step: number) {
    if (!this.page) return;
    const viewport = this.page.viewportSize();
    if (viewport) {
      await this.page.mouse.move(Math.round(viewport.width * 0.72), Math.round(viewport.height * 0.62)).catch(() => undefined);
      await this.page.mouse.wheel(0, step).catch(() => undefined);
    }

    await this.page
      .evaluate((scrollStep) => {
        const elements = [document.scrollingElement, ...document.querySelectorAll("*")]
          .filter((node): node is Element => Boolean(node))
          .map((node) => node as HTMLElement)
          .filter((element) => {
            const style = window.getComputedStyle(element);
            const canScroll = element.scrollHeight > element.clientHeight + 40;
            const visible = style.display !== "none" && style.visibility !== "hidden";
            const overflow = `${style.overflowY} ${style.overflow}`.toLowerCase();
            return canScroll && visible && !overflow.includes("hidden");
          })
          .sort((left, right) => right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight);

        for (const element of elements.slice(0, 6)) {
          element.scrollTop += scrollStep;
        }

        window.scrollBy(0, scrollStep);
      }, step)
      .catch(() => undefined);
  }

  private async clickFixtureContainerByTeam(target: Bet365ClickTarget | null | undefined, sourceUrl: string) {
    if (!this.page || !target?.homeTeam || !target.awayTeam) return null;

    const homeGroups = teamTokenGroups(target.homeTeam);
    const awayGroups = teamTokenGroups(target.awayTeam);
    if (!homeGroups.length || !awayGroups.length) return null;

    await this.page.keyboard.press("Home").catch(() => undefined);
    await this.page
      .evaluate(() => {
        for (const node of [document.scrollingElement, ...document.querySelectorAll("*")]) {
          const element = node as HTMLElement | null;
          if (element && element.scrollHeight > element.clientHeight + 40) element.scrollTop = 0;
        }
      })
      .catch(() => undefined);
    await this.page.waitForTimeout(500);

    for (let pageDown = 0; pageDown < 18; pageDown += 1) {
      const candidate = await this.page
        .evaluate(
          ({ homeGroups, awayGroups }) => {
            const normalize = (value: unknown) =>
              String(value ?? "")
                .normalize("NFD")
                .replace(/\p{Diacritic}/gu, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            const matchesGroup = (rawText: string, groups: string[][]) => {
              const normalized = normalize(rawText);
              const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
              return groups.some((group) => group.every((token) => (token.length <= 3 ? tokens.has(token) : normalized.includes(token))));
            };
            const selectors = [
              ".rcl-ParticipantFixtureDetails-clickable",
              "[class*='ParticipantFixtureDetails-clickable']",
              "[class*='ParticipantFixtureDetails']"
            ];
            const seen = new Set<Element>();
            const nodes = selectors.flatMap((selector) =>
              [...document.querySelectorAll(selector)].filter((node) => {
                if (seen.has(node)) return false;
                seen.add(node);
                return true;
              })
            );

            for (const node of nodes) {
              const element = node as HTMLElement;
              const text = element.innerText || element.textContent || "";
              if (!matchesGroup(text, homeGroups) || !matchesGroup(text, awayGroups)) continue;
              const rect = element.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 15) continue;
              if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

              return {
                x: rect.left + Math.min(Math.max(rect.width * 0.35, 24), rect.width - 6),
                y: rect.top + rect.height / 2,
                text: text.trim().slice(0, 180)
              };
            }

            return null;
          },
          { homeGroups, awayGroups }
        )
        .catch(() => null);

      if (candidate) {
        await this.page.mouse.click(candidate.x, candidate.y);
        if (await this.clickOpenedEvent(target)) {
          await this.logger?.("info", "evento da bet365 aberto por container DOM", {
            homeTeam: target.homeTeam,
            awayTeam: target.awayTeam,
            sourceUrl: this.page.url(),
            text: candidate.text
          });
          return target.homeTeam;
        }
        await this.restoreAfterRejectedClick(sourceUrl);
      }

      await this.scrollSearchViewport(850);
      await this.page.waitForTimeout(750);
    }

    return null;
  }

  private async clickEventByTeam(target: Bet365ClickTarget | null | undefined, sourceUrl: string) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    const containerClickedTeam = await this.clickFixtureContainerByTeam(target, sourceUrl);
    if (containerClickedTeam) return containerClickedTeam;

    for (const team of targetTeamNames(target)) {
      for (const alias of [...new Set(nationalTeamAliases(team).flatMap(withAmpersandAliases))]) {
        const locator = this.page.getByText(alias, { exact: false });
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          try {
            await locator.nth(index).click({ timeout: 2_500 });
            if (await this.clickOpenedEvent(target)) {
              await this.logger?.("info", "evento da bet365 aberto por clique DOM", { team, alias, sourceUrl: this.page.url() });
              return team;
            }
            await this.restoreAfterRejectedClick(sourceUrl);
          } catch {
            // Tenta o proximo match de texto visivel.
          }
        }
      }

      for (const pattern of teamNameSearchPatterns(team)) {
        const locator = this.page.getByText(pattern);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 10); index += 1) {
          try {
            await locator.nth(index).click({ timeout: 2_500 });
            if (await this.clickOpenedEvent(target)) {
              await this.logger?.("info", "evento da bet365 aberto por clique DOM flexivel", { team, pattern: pattern.source, sourceUrl: this.page.url() });
              return team;
            }
            await this.restoreAfterRejectedClick(sourceUrl);
          } catch {
            // Tenta o proximo match de texto visivel.
          }
        }
      }
    }

    await this.logger?.("warn", "nao encontrei jogo da bet365 para clique DOM", { target });
    return null;
  }

  private async readVisibleMoneylineMarkets(target: Bet365ClickTarget | null | undefined) {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");
    let rawText = "";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      rawText = await this.page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
      const markets = parseVisibleMoneylineMarkets([rawText], target);
      if (markets.length) {
        await this.logger?.("info", "mercados da bet365 lidos do DOM", {
          markets: markets.length,
          categories: markets.map((market) => market.paCategory)
        });
        return { markets, rawText };
      }
      await this.page.waitForTimeout(500);
    }

    return { markets: [], rawText };
  }

  async collectEventOdds(
    url: string,
    waitMs: number,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    if (!this.page) throw new Error("Browser da Bet365 nao conectado via CDP.");

    const payloads: string[] = [];
    let domMarkets: Bet365DomMarket[] = [];
    let pageText = "";
    let clickedTeam: string | null = null;
    let pageState: Bet365PageStateName = "UNKNOWN";
    const onWebSocket = (ws: WebSocket) => {
      ws.on("framereceived", (frame) => {
        const payload = payloadToString(frame.payload);
        if (looksLikeBet365Payload(payload)) payloads.push(payload);
      });
    };

    this.page.on("websocket", onWebSocket);
    try {
      let state = target ? await this.inspectCurrentPage(target, 1_500).catch(() => null) : null;
      if (state) pageState = state.name;

      if (!forceNavigate && target && pageStateIsTargetEvent(state)) {
        await this.logger?.("info", "pagina atual da bet365 ja esta no evento alvo", {
          state: state.name,
          sourceUrl: state.sourceUrl,
          markets: state.domMarkets.length
        });
      } else {
        await this.navigate(url, waitMs);
        state = target
          ? await this.waitForPageState(
              target,
              (candidate) => pageStateIsTargetEvent(candidate) || candidate.name === "LEAGUE",
              Math.max(4_000, Math.min(waitMs, 10_000))
            )
          : await this.inspectCurrentPage(target, 1_500).catch(() => null);
        if (state) pageState = state.name;
      }

      if (target && clickEvent) {
        if (!pageStateIsTargetEvent(state)) {
          if (state?.name !== "LEAGUE") {
            state = await this.waitForPageState(
              target,
              (candidate) => pageStateIsTargetEvent(candidate) || candidate.name === "LEAGUE",
              Math.max(4_000, Math.min(waitMs, 10_000))
            );
            pageState = state.name;
          }

          if (pageStateIsTargetEvent(state)) {
            await this.logger?.("info", "evento alvo da bet365 detectado sem novo clique", {
              state: state.name,
              sourceUrl: state.sourceUrl,
              markets: state.domMarkets.length
            });
          } else if (state?.name === "LEAGUE") {
            clickedTeam = await this.clickEventByTeam(target, url);
            const inspectedState = await this.inspectCurrentPage(target, 1_500).catch(() => null);
            if (inspectedState) state = inspectedState;
            pageState = state.name;
          }
        }
      }

      if (target && clickEvent && !clickedTeam && !pageStateIsTargetEvent(state)) {
        pageText = state?.pageText || (await this.pageBodyText(2_000));
        return {
          sourceUrl: this.page.url(),
          payloads,
          domMarkets,
          clickedTeam,
          pageText,
          pageState
        };
      }

      if (target && pageStateIsTargetEvent(state)) {
        state = await this.waitForPageState(target, (candidate) => candidate.name === "EVENT_READY", Math.min(waitMs, 6_000));
        pageState = state.name;
      }

      await this.page.waitForTimeout(pageState === "EVENT_READY" ? Math.min(waitMs, 2_500) : waitMs);
      try {
        const domRead = await this.readVisibleMoneylineMarkets(target);
        domMarkets = domRead.markets;
        pageText = domRead.rawText;
        pageState = this.classifyPageState(this.page.url(), pageText, target).name;
      } catch (error) {
        await this.logger?.("warn", "leitura DOM da bet365 falhou", {
          error: error instanceof Error ? error.message : String(error)
        });
        pageText = await this.page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
        pageState = this.classifyPageState(this.page.url(), pageText, target).name;
      }
      return {
        sourceUrl: this.page.url(),
        payloads,
        domMarkets,
        clickedTeam,
        pageText,
        pageState
      };
    } finally {
      this.page.off("websocket", onWebSocket);
    }
  }

  async close() {
    if (this.closePageOnClose) {
      await this.page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
  }
}

export class Bet365NetworkClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mainController: Bet365PageController | null = null;

  constructor(private readonly logger?: Logger) {}

  async connectToExistingChrome(debugPort: number) {
    if (this.browser?.isConnected() && this.context && this.mainController) return;

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const contexts = browser.contexts();
    const context = contexts[0] ?? (await browser.newContext());
    const pages = context.pages();
    const bet365Page = pages.find((page) => page.url().includes("bet365"));
    const page = bet365Page ?? pages[0] ?? (await context.newPage());

    this.browser = browser;
    this.context = context;
    this.mainController = new Bet365PageController(page, this.logger, false);
    await this.logger?.("info", "cliente CDP da bet365 conectado", { debugPort, pages: pages.length });
  }

  private requireMainController() {
    if (!this.mainController) throw new Error("Browser da Bet365 nao conectado via CDP.");
    return this.mainController;
  }

  private async newTabController() {
    if (!this.context) throw new Error("Browser da Bet365 nao conectado via CDP.");
    const page = await this.context.newPage();
    return new Bet365PageController(page, this.logger, true);
  }

  async navigate(url: string, timeoutMs: number) {
    return this.requireMainController().navigate(url, timeoutMs);
  }

  async currentUrl() {
    return this.mainController?.currentUrl() ?? "";
  }

  async collectEventOdds(
    url: string,
    waitMs: number,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    return this.requireMainController().collectEventOdds(url, waitMs, target, clickEvent, forceNavigate);
  }

  async collectEventOddsInNewTab(
    url: string,
    waitMs: number,
    target?: Bet365ClickTarget | null,
    clickEvent = Boolean(target),
    forceNavigate = false
  ): Promise<Bet365NetworkCapture> {
    const controller = await this.newTabController();
    try {
      return await controller.collectEventOdds(url, waitMs, target, clickEvent, forceNavigate);
    } finally {
      await controller.close();
    }
  }

  async withNewTab<T>(worker: (tab: Bet365NetworkTabSession) => Promise<T>): Promise<T> {
    const controller = await this.newTabController();
    const tab: Bet365NetworkTabSession = {
      collectEventOdds: (url, waitMs, target, clickEvent = Boolean(target), forceNavigate = false) =>
        controller.collectEventOdds(url, waitMs, target, clickEvent, forceNavigate)
    };

    try {
      return await worker(tab);
    } finally {
      await controller.close();
    }
  }

  async close() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.mainController = null;
  }
}
