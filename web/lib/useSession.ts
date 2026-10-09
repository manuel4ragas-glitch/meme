"use client";
import { useEffect, useState } from "react";
import { getBrowserSupabase } from "./supabase-browser";

// undefined = aún no se sabe; null = sin sesión
export function useSessionEmail(): string | null | undefined {
  const [email, setEmail] = useState<string | null | undefined>(() => (getBrowserSupabase() ? undefined : null));
  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb) return;
    void sb.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
    const { data } = sb.auth.onAuthStateChange((_e, session) => setEmail(session?.user.email ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  return email;
}
