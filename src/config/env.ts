import "dotenv/config";
import { z } from "zod";

const optionalNonEmptyString = () =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") return undefined;
    return value;
  }, z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  SUPABASE_URL: z
    .string()
    .url()
    .refine((value) => !value.startsWith("sb_"), "Use o Project URL do Supabase, não uma API key."),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: optionalNonEmptyString(),
  API_FOOTBALL_BASE_URL: z.string().url().default("https://v3.football.api-sports.io"),
  API_FOOTBALL_KEY: z.string().min(1),
  API_FOOTBALL_TIMEZONE: z.string().default("America/Bahia"),
  API_FOOTBALL_FIXTURE_TTL_MINUTES: z.coerce.number().int().min(1).default(720),
  ALTENAR_BASE_URL: z.string().url().default("https://sb2frontend-altenar2.biahosted.com/api/"),
  COLLECT_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  MERIDIANBET_BASE_URL: z.string().url().default("https://meridianbet.bet.br/"),
  MERIDIANBET_CHROME_PROFILE_DIR: z.string().default(".browser/meridianbet-cdp-profile"),
  MERIDIANBET_CHROME_EXECUTABLE: optionalNonEmptyString(),
  MERIDIANBET_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(5000).default(45_000),
  MERIDIANBET_MONITOR_TABS: z.coerce.number().int().min(1).max(8).default(5),
  BET365_BASE_URL: z.string().url().default("https://www.bet365.bet.br/"),
  BET365_CHROME_PROFILE_DIR: z.string().default(".browser/bet365-profile"),
  BET365_CHROME_EXECUTABLE: optionalNonEmptyString(),
  BET365_NAVIGATION_WAIT_MS: z.coerce.number().int().min(5000).default(12_000),
  BET365_EVENT_WAIT_MS: z.coerce.number().int().min(1000).default(6_000),
  BET365_DEBUG_PORT: z.coerce.number().int().min(1024).max(65535).default(9223),
  BET365_MONITOR_TABS: z.coerce.number().int().min(1).max(5).default(5),
  BET365_ENABLED: z.coerce.boolean().default(false),
  BET365_COMPETITION_URL: optionalNonEmptyString(),
  BET365_TARGET_LEAGUE_SLUG: optionalNonEmptyString(),
  BET365_TARGET_LEAGUE_SLUGS: optionalNonEmptyString(),
  BET365_FIXTURE_LIMIT: z.coerce.number().int().min(1).max(25).optional(),
  BET365_FIXTURE_LIMIT_PER_LEAGUE: z.coerce.number().int().min(1).max(25).default(25),
  BET365_EVENT_TEXT_FILE: optionalNonEmptyString(),
});

export const env = envSchema.parse({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
});
