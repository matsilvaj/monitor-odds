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
});

export const env = envSchema.parse({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
});
