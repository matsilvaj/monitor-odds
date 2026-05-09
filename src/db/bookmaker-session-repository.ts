import { supabase } from "./supabase.js";

export type BookmakerSession = {
  bookmakerSlug: string;
  xNetSyncTerm: string;
  cookie: string;
  capturedFrom: string | null;
  capturedAt: string;
  expiresAt: string;
  raw: unknown;
};

type BookmakerSessionRow = {
  bookmaker_slug: string;
  x_net_sync_term: string;
  cookie: string;
  captured_from: string | null;
  captured_at: string;
  expires_at: string;
  raw: unknown;
};

function mapSession(row: BookmakerSessionRow): BookmakerSession {
  return {
    bookmakerSlug: row.bookmaker_slug,
    xNetSyncTerm: row.x_net_sync_term,
    cookie: row.cookie,
    capturedFrom: row.captured_from,
    capturedAt: row.captured_at,
    expiresAt: row.expires_at,
    raw: row.raw
  };
}

export class BookmakerSessionRepository {
  static async save(session: BookmakerSession) {
    const { error } = await supabase.from("bookmaker_sessions").upsert(
      {
        bookmaker_slug: session.bookmakerSlug,
        x_net_sync_term: session.xNetSyncTerm,
        cookie: session.cookie,
        captured_from: session.capturedFrom,
        captured_at: session.capturedAt,
        expires_at: session.expiresAt,
        raw: session.raw ?? {},
        updated_at: new Date().toISOString()
      },
      { onConflict: "bookmaker_slug" }
    );

    if (error) throw error;
  }

  static async getActive(bookmakerSlug: string) {
    const { data, error } = await supabase
      .from("bookmaker_sessions")
      .select("bookmaker_slug,x_net_sync_term,cookie,captured_from,captured_at,expires_at,raw")
      .eq("bookmaker_slug", bookmakerSlug)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (error) throw error;
    return data ? mapSession(data as BookmakerSessionRow) : null;
  }
}
