import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3333),
  SUPABASE_URL: z
    .string()
    .url()
    .refine((value) => !value.startsWith("sb_"), "Use o Project URL do Supabase, nao uma API key."),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().optional(),
  API_FOOTBALL_BASE_URL: z.string().url().default("https://v3.football.api-sports.io"),
  API_FOOTBALL_KEY: z.string().min(1),
  API_FOOTBALL_TIMEZONE: z.string().default("America/Bahia"),
  API_FOOTBALL_FIXTURE_TTL_MINUTES: z.coerce.number().int().min(1).default(720),
  INTERNAL_COLLECT_TOKEN: z.string().optional(),
  ALTENAR_BASE_URL: z.string().url().default("https://sb2frontend-altenar2.biahosted.com/api/"),
  ALTENAR_INTEGRATION: z.string().default("esportiva"),
  COLLECT_DELAY_MS: z.coerce.number().int().min(0).default(1500),
  COLLECT_JITTER_MS: z.coerce.number().int().min(0).default(2000),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(7)
});

export const env = envSchema.parse({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
});
