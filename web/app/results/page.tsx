import { Suspense } from "react";
import AutoRefresh from "@/components/AutoRefresh";
import { getResults } from "@/lib/data";
import type { AgeCohort, OutcomeSummary } from "@/lib/types";

const MIN_N = 30;
const VERDICT: Record<string, string> = { alert: "Alerta", candidate: "Candidato", discarded: "Descartado" };

// Una mediana con menos de MIN_N observaciones se muestra atenuada: no es evidencia.
function Cell({ v, n, suffix = "%" }: { v: number | null; n: number; suffix?: string }) {
  if (v == null || n === 0) return <td className="py-1 pr-3 text-right text-zinc-700">—</td>;
  const weak = n < MIN_N;
  const tone = weak ? "text-zinc-500" : v >= 0 ? "text-emerald-400" : "text-red-400";
  return (
    <td className={`py-1 pr-3 text-right ${tone}`} title={`n = ${n}${weak ? " (muestra pequeña)" : ""}`}>
      {v > 0 && suffix === "%" ? "+" : ""}{v}{suffix} <span className="text-[9px] text-zinc-600">n{n}</span>
    </td>
  );
}

function SummaryTable({ rows }: { rows: OutcomeSummary[] }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">Aún no hay resultados.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="py-1 pr-3">Veredicto</th><th className="pr-3">Edad en la señal</th><th className="pr-3 text-right">Señales</th>
            <th className="pr-3 text-right">+5m</th><th className="pr-3 text-right">+15m</th><th className="pr-3 text-right">+60m</th>
            <th className="pr-3 text-right">+6h</th><th className="pr-3 text-right">+24h</th>
            <th className="pr-3 text-right">Máx. posterior</th><th className="pr-3 text-right">Caída máx.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.verdict}-${r.age_bucket}`} className="border-t border-zinc-900 text-zinc-200">
              <td className="py-1 pr-3">{VERDICT[r.verdict] ?? r.verdict}</td>
              <td className="pr-3">{r.age_bucket}</td>
              <td className="pr-3 text-right">{r.n}</td>
              <Cell v={r.med_5m} n={r.n_5m} />
              <Cell v={r.med_15m} n={r.n_15m} />
              <Cell v={r.med_60m} n={r.n_60m} />
              <Cell v={r.med_6h} n={r.n_6h} />
              <Cell v={r.med_24h} n={r.n_24h} />
              <Cell v={r.med_max_return} n={r.n} />
              <Cell v={r.med_max_drawdown} n={r.n} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Mult({ v, n }: { v: number | null; n: number }) {
  if (v == null || n === 0) return <td className="py-1 pr-3 text-right text-zinc-700">—</td>;
  const tone = n < MIN_N ? "text-zinc-500" : v >= 1 ? "text-emerald-400" : "text-red-400";
  return <td className={`py-1 pr-3 text-right ${tone}`}>×{v} <span className="text-[9px] text-zinc-600">n{n}</span></td>;
}

function CohortTable({ rows }: { rows: AgeCohort[] }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">Aún no hay tokens con marca de 5 min.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="py-1 pr-3">Grupo</th><th className="pr-3 text-right">Tokens (5m)</th>
            <th className="pr-3 text-right">a 15m</th><th className="pr-3 text-right">a 60m</th><th className="pr-3 text-right">a 6h</th><th className="pr-3 text-right">a 24h</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cohort} className="border-t border-zinc-900 text-zinc-200">
              <td className="py-1 pr-3">{r.cohort}</td>
              <td className="pr-3 text-right">{r.n_base}</td>
              <Mult v={r.med_x_15m} n={r.n_15m} />
              <Mult v={r.med_x_60m} n={r.n_60m} />
              <Mult v={r.med_x_6h} n={r.n_6h} />
              <Mult v={r.med_x_24h} n={r.n_24h} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Results() {
  let data;
  try {
    data = await getResults();
  } catch (e) {
    return <p className="text-sm text-red-400">No se pudo leer Supabase: {e instanceof Error ? e.message : String(e)}</p>;
  }
  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Retorno tras cada señal (mediana)</h2>
        <SummaryTable rows={data.summary} />
        <p className="mt-2 text-[11px] text-zinc-500">
          {data.total} señales medidas, {data.complete} con la ventana cerrada. Cada retorno parte del último snapshot <b>anterior</b> a la señal
          y solo usa datos posteriores para medir el resultado. «Máx. posterior» y «Caída máx.» (pico a valle) cubren hasta 24 h después.
        </p>
      </section>
      <section>
        <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Mismo token, misma edad (MCap vs. su marca de 5 min)</h2>
        <CohortTable rows={data.cohorts} />
        <p className="mt-2 text-[11px] text-zinc-500">
          Compara tokens a la misma edad desde el lanzamiento. Incluye tokens muertos, pero un token muerto deja de medirse: la caída de
          <b> n</b> de una columna a la siguiente es justamente el sesgo de supervivencia. El grupo es descriptivo, no predictivo.
        </p>
      </section>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-3 py-3 font-mono">
      <h1 className="mb-1 text-base font-semibold text-zinc-100">Resultados y backtesting</h1>
      <div className="mb-4 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200/90">
        Atención: con pocas señales las cifras no son evidencia. Las celdas con menos de {MIN_N} observaciones salen atenuadas (n = tamaño de muestra).
        Un retorno positivo aquí no es una probabilidad de ganancia ni una recomendación: el sistema solo analiza, no opera.
        Los valores «arrastrados» (token muerto antes del horizonte) se excluyen de las medianas.
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Cargando…</p>}><Results /></Suspense>
      <AutoRefresh seconds={120} />
    </main>
  );
}
