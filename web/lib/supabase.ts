import { createClient } from "@supabase/supabase-js";

// Solo la clave publicable (anon): la service role nunca va al frontend.
export function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { db: { schema: "memes" }, auth: { persistSession: false } });
}
