import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

const clientOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
};

export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, clientOptions);

export const supabasePublic = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY, clientOptions);

export const supabase = supabaseAdmin;
