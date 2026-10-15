/** Cliente de Supabase (proyecto PROPIO del bot Añelo; tablas anelo_*). */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseConfig } from "../config.js";

export function createSupabase(config: SupabaseConfig): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Lanza un error legible si Supabase devolvió uno. */
export function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`Supabase (${what}): ${result.error.message}`);
  return result.data;
}
