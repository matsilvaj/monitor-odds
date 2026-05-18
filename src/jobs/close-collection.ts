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

  const { data, error } = await supabase
    .from("bookmaker_collection_state")
    .update({
      status: "idle",
      lease_until: null,
      last_error: null,
      updated_at: now
    })
    .in("bookmaker_slug", targets)
    .select("bookmaker_slug,status,lease_until,next_run_at,last_error");

  if (error) {
    console.error(error.message);
    process.exitCode = 1;
  } else if (!data?.length) {
    console.log(`Nenhuma coleta aberta encontrada para: ${target}.`);
  } else {
    for (const row of data) {
      console.log(`[${row.bookmaker_slug}] coleta liberada.`);
      console.log(`status: ${row.status}`);
      console.log(`lease_until: ${row.lease_until ?? "null"}`);
      console.log(`next_run_at: ${row.next_run_at ?? "null"}`);
      console.log(`last_error: ${row.last_error ?? "null"}`);
    }
  }
}
