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

// ¿La sesión actual está en memes.admins? Solo ellos pueden editar rules (RLS); aquí solo se decide si se muestra el botón.
export function useIsAdmin(email: string | null | undefined): boolean | undefined {
  const [state, setState] = useState<{ email: string; admin: boolean } | null>(null);
  useEffect(() => {
    const sb = getBrowserSupabase();
    if (!sb || !email) return;
    void sb.from("admins").select("user_id").maybeSingle().then(({ data }) => setState({ email, admin: !!data }));
  }, [email]);
  if (email === undefined) return undefined;
  if (email === null) return false;
  return state?.email === email ? state.admin : undefined;
}
