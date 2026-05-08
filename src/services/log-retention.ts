import { env } from "../config/env.js";
import { supabase } from "../db/supabase.js";

export async function cleanupOldLogs() {
  const cutoff = new Date(Date.now() - env.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from("collection_logs").delete().lt("created_at", cutoff);

  if (error) throw error;
}
