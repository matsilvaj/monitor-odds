import { BOOKMAKERS } from "../config/bookmakers.js";
import { supabase } from "../db/supabase.js";

const browserCollectorSlugs = ["bet365", "meridianbet"];
const [rawTarget = "chrome"] = process.argv.slice(2);
const target = rawTarget.trim().toLowerCase();
const knownSlugs = new Set(BOOKMAKERS.map((bookmaker) => bookmaker.slug));
const targetAliases = new Set(["chrome", "browser", "navegador"]);

if (target !== "all" && !targetAliases.has(target) && !knownSlugs.has(target)) {
  console.error(`Casa nao configurada: ${target}`);
  console.error("Use: npm run fechar:coleta");
  console.error("Ou: npm run fechar:coleta bet365 | meridianbet | all");
  process.exitCode = 1;
} else {
  const targets = target === "all" ? [...knownSlugs] : targetAliases.has(target) ? browserCollectorSlugs : [target];
  const now = new Date().toISOString();
  const bookmakersBySlug = new Map(BOOKMAKERS.map((bookmaker) => [bookmaker.slug, bookmaker.name]));

  const { error: bookmakerError } = await supabase.from("bookmakers").upsert(
    targets.map((bookmakerSlug) => ({ slug: bookmakerSlug, name: bookmakersBySlug.get(bookmakerSlug) ?? bookmakerSlug })),
    { onConflict: "slug" }
  );

  const { data, error } = bookmakerError
    ? { data: null, error: bookmakerError }
    : await supabase
    .from("bookmaker_collection_state")
    .upsert(
      targets.map((bookmakerSlug) => ({
        bookmaker_slug: bookmakerSlug,
        status: "idle",
        lease_until: null,
        last_error: null,
        updated_at: now
      })),
      { onConflict: "bookmaker_slug" }
    )
    .select("bookmaker_slug,status,lease_until,next_run_at,last_error");

  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    for (const row of data ?? []) {
      console.log(`[${row.bookmaker_slug}] coleta liberada.`);
      console.log(`status: ${row.status}`);
      console.log(`lease_until: ${row.lease_until ?? "null"}`);
      console.log(`next_run_at: ${row.next_run_at ?? "null"}`);
      console.log(`last_error: ${row.last_error ?? "null"}`);
    }
  }
}
