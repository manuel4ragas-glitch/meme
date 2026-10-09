import Link from "next/link";
import { Suspense } from "react";
import AutoRefresh from "@/components/AutoRefresh";
import Badge from "@/components/Badge";
import Reasons from "@/components/Reasons";
import { getRecentSignals } from "@/lib/data";
import { fmtTime } from "@/lib/format";
import type { Tone } from "@/lib/verdict";

const TONE: Record<string, Tone> = { alert: "ok", candidate: "warn", discarded: "bad", dead: "muted", tracking: "muted" };
const LABEL: Record<string, string> = { alert: "ALERTA", candidate: "CANDIDATO", discarded: "DESCARTADO", dead: "MUERTO", tracking: "SIGUIENDO" };

async function List() {
  let signals;
  try {
    signals = await getRecentSignals();
  } catch (e) {
    return <p className="text-sm text-red-400">No se pudo leer Supabase: {e instanceof Error ? e.message : String(e)}</p>;
  }
  if (!signals.length) return <p className="text-sm text-zinc-500">Aún no hay señales.</p>;
  return (
    <ul className="divide-y divide-zinc-900">
      {signals.map((s) => (
        <li key={s.id} className="py-2">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="w-24 text-xs text-zinc-500">{fmtTime(s.ts)}</span>
              <Link href={`/token/${s.mint}`} prefetch={false} className="font-semibold text-zinc-100 hover:underline">
                {s.tokens?.symbol ?? s.mint.slice(0, 6)}
              </Link>
              <Badge label={LABEL[s.verdict] ?? s.verdict.toUpperCase()} tone={TONE[s.verdict] ?? "muted"} />
            </summary>
            <div className="mt-2 pl-4"><Reasons reasons={s.reasons} /></div>
          </details>
        </li>
      ))}
    </ul>
  );
}

export default function SignalsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-3 py-3 font-mono">
      <h1 className="mb-2 text-base font-semibold text-zinc-100">Historial de señales</h1>
      <p className="mb-3 text-xs text-zinc-500">Cada cambio de veredicto, con las reglas evaluadas en ese momento (sin los tokens muertos). Toca una fila para ver los motivos.</p>
      <Suspense fallback={<p className="text-sm text-zinc-500">Cargando…</p>}><List /></Suspense>
      <AutoRefresh seconds={60} />
    </main>
  );
}
