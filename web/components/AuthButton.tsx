"use client";
import Link from "next/link";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { useSessionEmail } from "@/lib/useSession";

export default function AuthButton() {
  const email = useSessionEmail();
  if (email === undefined) return null;
  if (!email) return <Link href="/login" prefetch={false} className="text-xs text-zinc-400 hover:text-white">Entrar</Link>;
  return (
    <button onClick={() => void getBrowserSupabase()?.auth.signOut()} className="text-xs text-zinc-400 hover:text-white" title={email}>
      Salir
    </button>
  );
}
