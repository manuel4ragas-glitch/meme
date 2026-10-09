import { Suspense } from "react";
import { connection } from "next/server";
import { getSupabase } from "@/lib/supabase";

async function Health() {
  await connection();
  const supabase = getSupabase();
  if (!supabase) {
    return <p className="text-amber-400">Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY en Vercel.</p>;
  }

  const [run, tokens] = await Promise.all([
    supabase.from("collector_runs").select("ts, tokens_seen, snapshots_saved, errors, duration_ms").order("ts", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("tokens").select("mint", { count: "exact", head: true }),
  ]);

  if (run.error) return <p className="text-red-400">Error leyendo Supabase: {run.error.message}</p>;
  if (!run.data) return <p className="text-zinc-400">Conectado, pero aún no hay ejecuciones del recolector.</p>;

  const ageMin = Math.round((Date.now() - new Date(run.data.ts).getTime()) / 60000);
  const ok = ageMin <= 3 && run.data.errors === 0;
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-2 font-mono text-sm">
      <dt className="text-zinc-500">Estado</dt>
      <dd className={ok ? "text-emerald-400" : "text-amber-400"}>{ok ? "saludable" : "revisar"}</dd>
      <dt className="text-zinc-500">Última ejecución</dt>
      <dd>hace {ageMin} min</dd>
      <dt className="text-zinc-500">Tokens vistos / snapshots</dt>
      <dd>{run.data.tokens_seen} / {run.data.snapshots_saved}</dd>
      <dt className="text-zinc-500">Errores</dt>
      <dd>{run.data.errors}</dd>
      <dt className="text-zinc-500">Tokens totales</dt>
      <dd>{tokens.count ?? "—"}</dd>
    </dl>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-4 py-10">
      <h1 className="font-mono text-xl text-zinc-100">Solana Meme Analyzer</h1>
      <Suspense fallback={<p className="font-mono text-sm text-zinc-500">Cargando…</p>}>
        <Health />
      </Suspense>
    </main>
  );
}
