import { BOOKMAKER_COLLECTORS } from "../bookmakers/registry.js";
import type { BookmakerCollectOptions } from "../bookmakers/types.js";
import { cleanupStartedFixtures, formatStartedFixtureCleanupSummary } from "../services/fixture-cleanup.js";
import { formatBookmakerResultLines, formatBookmakerStartLine, getBookmakerOddsReport, getFixtureReport } from "../services/sync-report.js";

const [slug, ...args] = process.argv.slice(2);

function parseOptions(rawArgs: string[]): BookmakerCollectOptions {
  const options: BookmakerCollectOptions = { logToConsole: true };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === "--date") {
      options.date = rawArgs[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("--date=")) {
      options.date = arg.slice("--date=".length);
      continue;
    }

    if (arg === "--no-manual") {
      options.manualFallback = false;
      continue;
    }

    if (arg === "--trigger") {
      const trigger = rawArgs[index + 1];
      if (trigger === "manual" || trigger === "sync" || trigger === "watch") {
        options.trigger = trigger;
        index += 1;
      }
      continue;
    }

    if (!arg.startsWith("--") && !options.date) {
      options.date = arg;
    }
  }

  return options;
}

if (!slug) {
  console.error("Informe a casa: npm run collect:bookmaker esportiva");
  process.exitCode = 1;
} else {
  const bookmaker = BOOKMAKER_COLLECTORS.find((item) => item.slug === slug);

  if (!bookmaker) {
    console.error(`Casa nao configurada ou desativada: ${slug}`);
    process.exitCode = 1;
  } else {
    try {
      const options = parseOptions(args);
      if (options.trigger !== "watch") {
        options.trigger ??= "manual";
      }
      const cleanup = await cleanupStartedFixtures();
      console.log(formatStartedFixtureCleanupSummary(cleanup));
      const fixtureReport = await getFixtureReport();
      console.log(formatBookmakerStartLine(bookmaker.slug, fixtureReport));
      const startedAt = performance.now();
      const summary = await bookmaker.collect(options);
      const durationMs = Math.round(performance.now() - startedAt);
      const report = await getBookmakerOddsReport(bookmaker.slug, fixtureReport);
      for (const line of formatBookmakerResultLines({ bookmaker: bookmaker.slug, summary, durationMs }, report)) {
        console.log(line);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
