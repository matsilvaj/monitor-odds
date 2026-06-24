import type { Bet365BookmakerConfig } from "../config/bookmakers.js";
import { supabase } from "../db/supabase.js";

export class Bet365CollectionStateRepository {
  async ensureBaseRows(bookmaker: Bet365BookmakerConfig) {
    const { error } = await supabase.from("bookmakers").upsert({ slug: bookmaker.slug, name: bookmaker.name }, { onConflict: "slug" });
    if (error) throw error;

    const { error: stateError } = await supabase.from("bookmaker_collection_state").upsert(
      {
        bookmaker_slug: bookmaker.slug,
        status: "idle",
        updated_at: new Date().toISOString()
      },
      { onConflict: "bookmaker_slug", ignoreDuplicates: true }
    );
    if (stateError) throw stateError;
  }

  async markRunning(slug: string) {
    await this.update(slug, {
      status: "running",
      lease_until: null,
      last_error: null
    });
  }

  async markDone(slug: string, summary: Record<string, unknown>) {
    await this.update(slug, {
      status: "idle",
      lease_until: null,
      last_finished_at: new Date().toISOString(),
      last_error: null,
      summary
    });
  }

  async markError(slug: string, error: string | null, summary: Record<string, unknown>) {
    await this.update(slug, {
      status: error ? "error" : "idle",
      lease_until: null,
      last_finished_at: new Date().toISOString(),
      last_error: error,
      summary
    });
  }

  async update(slug: string, values: Record<string, unknown>) {
    const { error } = await supabase
      .from("bookmaker_collection_state")
      .update({
        ...values,
        updated_at: new Date().toISOString()
      })
      .eq("bookmaker_slug", slug);
    if (error) throw error;
  }
}

