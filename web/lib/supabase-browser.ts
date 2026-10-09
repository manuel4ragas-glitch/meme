"use client";
import { createClient } from "@supabase/supabase-js";

const make = (url: string, key: string) => createClient(url, key, { db: { schema: "memes" } });
let client: ReturnType<typeof make> | null = null;

// Clave publicable: la sesión del usuario (si inicia sesión) es lo que habilita editar `rules` por RLS.
export function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  client ??= make(url, key);
  return client;
}
