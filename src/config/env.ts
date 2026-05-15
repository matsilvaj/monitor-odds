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

const envSchema = z
  .object({
    NODE_ENV: z.string().default("development"),
    PORT: z.coerce.number().default(3333),
    API_HOST: z.string().default("0.0.0.0"),
    CORS_ORIGINS: z.string().default(""),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
    PUBLIC_API_TOKEN: optionalNonEmptyString(),
    SUPABASE_URL: z
      .string()
      .url()
      .refine((value) => !value.startsWith("sb_"), "Use o Project URL do Supabase, nao uma API key."),
    SUPABASE_PUBLISHABLE_KEY: optionalNonEmptyString(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_DB_URL: optionalNonEmptyString(),
    API_FOOTBALL_BASE_URL: z.string().url().default("https://v3.football.api-sports.io"),
    API_FOOTBALL_KEY: z.string().min(1),
    API_FOOTBALL_TIMEZONE: z.string().default("America/Bahia"),
    API_FOOTBALL_FIXTURE_TTL_MINUTES: z.coerce.number().int().min(1).default(720),
    INTERNAL_COLLECT_TOKEN: optionalNonEmptyString(),
    ALTENAR_BASE_URL: z.string().url().default("https://sb2frontend-altenar2.biahosted.com/api/"),
    COLLECT_DELAY_MS: z.coerce.number().int().min(0).default(1500),
    LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
    BET365_BASE_URL: z.string().url().default("https://www.bet365.bet.br/"),
    BET365_CHROME_PROFILE_DIR: z.string().default(".browser/bet365-cdp-profile"),
    BET365_CHROME_EXECUTABLE: optionalNonEmptyString(),
    BET365_MANUAL_FALLBACK: booleanFromEnv(true),
    BET365_KEEP_BROWSER_OPEN: booleanFromEnv(false),
    BET365_NAVIGATION_TIMEOUT_MS: z.coerce.number().int().min(5000).default(45_000),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;

    if (!value.SUPABASE_PUBLISHABLE_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_PUBLISHABLE_KEY"],
        message: "Obrigatorio em producao para rotas publicas respeitarem RLS."
      });
    }

    if (!value.INTERNAL_COLLECT_TOKEN || value.INTERNAL_COLLECT_TOKEN.length < 32) {
      context.addIssue({
        code: "custom",
        path: ["INTERNAL_COLLECT_TOKEN"],
        message: "Obrigatorio em producao e deve ter pelo menos 32 caracteres."
      });
    }

    if (!value.PUBLIC_API_TOKEN || value.PUBLIC_API_TOKEN.length < 32) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_API_TOKEN"],
        message: "Obrigatorio em producao e deve ter pelo menos 32 caracteres."
      });
    }
  });

export const env = envSchema.parse({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY:
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
});
