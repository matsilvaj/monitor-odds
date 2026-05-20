import "dotenv/config";
import { z } from "zod";

const optionalNonEmptyString = () =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") return undefined;
    return value;
  }, z.string().optional());

const booleanFromEnv = (defaultValue: boolean) =>
  z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") return defaultValue;
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return ["1", "true", "yes", "sim", "on"].includes(value.trim().toLowerCase());
      return Boolean(value);
    }, z.boolean())
    .default(defaultValue);

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
  BET365_BASE_URL: z.string().url().default("https://www.bet365.bet.br/"),
  BET365_CHROME_PROFILE_DIR: z.string().default(".browser/bet365-cdp-profile"),
  BET365_CHROME_EXECUTABLE: optionalNonEmptyString(),
  BET365_MANUAL_FALLBACK: booleanFromEnv(true),
  BET365_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(5000).default(45_000),
  MERIDIANBET_BASE_URL: z.string().url().default("https://meridianbet.bet.br/"),
  MERIDIANBET_CHROME_PROFILE_DIR: z.string().default(".browser/meridianbet-cdp-profile"),
  MERIDIANBET_CHROME_EXECUTABLE: optionalNonEmptyString(),
  MERIDIANBET_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(5000).default(45_000),
});

export const env = envSchema.parse({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
});
