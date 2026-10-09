"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase-browser";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const sb = getBrowserSupabase();
    if (!sb) { setError("Faltan las variables de Supabase."); return; }
    setBusy(true);
    const { error } = await sb.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setError(error.message);
    else router.push("/rules");
  }

  return (
    <main className="mx-auto w-full max-w-sm px-3 py-10 font-mono">
      <h1 className="mb-1 text-base font-semibold text-zinc-100">Iniciar sesión</h1>
      <p className="mb-4 text-xs text-zinc-500">Solo para editar las reglas. El dashboard se puede ver sin cuenta.</p>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <input type="email" required autoComplete="email" placeholder="correo" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        <input type="password" required autoComplete="current-password" placeholder="contraseña" value={password} onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
        <button disabled={busy} className="w-full rounded border border-emerald-600 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-600/20 disabled:opacity-50">
          {busy ? "Entrando…" : "Entrar"}
        </button>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </form>
    </main>
  );
}
