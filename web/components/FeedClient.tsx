"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { fmtAge, fmtPct, fmtUsd } from "@/lib/format";
import { PAGE_SIZE, toSearch, type FeedQuery, type Sort } from "@/lib/feedQuery";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { useIsAdmin, useSessionEmail } from "@/lib/useSession";
import { verdictOf } from "@/lib/verdict";
import type { FeedRow, Rules, Status } from "@/lib/types";
import Badge from "./Badge";
import Momentum from "./Momentum";

const STATUSES: { key: Status; label: string }[] = [
  { key: "alert", label: "Alerta" },
  { key: "candidate", label: "Candidato" },
  { key: "discarded", label: "Descartado" },
  { key: "tracking", label: "Siguiendo" },
];
const GRID = "md:grid md:grid-cols-[1.3fr_.5fr_.8fr_.8fr_.6fr_1.5fr_.6fr_.8fr_1fr] md:items-center md:gap-2";

const num = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
};
const str = (n: number | null) => (n == null ? "" : String(n));

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
      {label}
      <input
        inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-sm normal-case text-zinc-100 outline-none focus:border-emerald-500"
      />
    </label>
  );
}

// Los filtros viven en la URL y los aplica el servidor en la consulta; aquí solo se editan y se envían (con retardo).
export default function FeedClient({ rows, total, query, rules }: { rows: FeedRow[]; total: number; query: FeedQuery; rules: Rules }) {
  const router = useRouter();
  const email = useSessionEmail();
  const isAdmin = useIsAdmin(email);
  const [pending, startTransition] = useTransition();
  const [mcapMin, setMcapMin] = useState(str(query.mcapMin));
  const [mcapMax, setMcapMax] = useState(str(query.mcapMax));
  const [liqMin, setLiqMin] = useState(str(query.liqMin));
  const [maxAge, setMaxAge] = useState(str(query.maxAge));
  const [on, setOn] = useState<Set<Status>>(new Set(query.statuses));
  const [sort, setSort] = useState<Sort>(query.sort);
  const [limit, setLimit] = useState(query.limit);
  const [msg, setMsg] = useState<string | null>(null);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const id = setTimeout(() => {
      const next: FeedQuery = {
        statuses: STATUSES.map((s) => s.key).filter((k) => on.has(k)),
        mcapMin: num(mcapMin), mcapMax: num(mcapMax), liqMin: num(liqMin), maxAge: num(maxAge), sort, limit,
      };
      startTransition(() => router.replace(`/?${toSearch(next)}`, { scroll: false }));
    }, 400);
    return () => clearTimeout(id);
  }, [mcapMin, mcapMax, liqMin, maxAge, on, sort, limit, router]);

  async function save() {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const { error } = await sb.from("rules").update({
      mcap_min: num(mcapMin) ?? rules.mcap_min, mcap_max: num(mcapMax) ?? rules.mcap_max,
      liq_min: num(liqMin) ?? rules.liq_min, max_age_min: num(maxAge) ?? rules.max_age_min,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    setMsg(error ? `Error: ${error.message}` : "Guardado en reglas");
    if (!error) router.refresh();
  }

  const toggle = (s: Status) => { setLimit(PAGE_SIZE); setOn((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; }); };
  const canSave = isAdmin === true;
  const saveHint = email === null ? "Inicia sesión para guardar" : isAdmin === false ? "Tu cuenta no es administradora" : "Guarda estos valores en la tabla rules";

  return (
    <div className="font-mono">
      <div className="flex flex-wrap items-end gap-3 border-b border-zinc-800 pb-3">
        <Field label="MCap mín" value={mcapMin} onChange={(v) => { setLimit(PAGE_SIZE); setMcapMin(v); }} />
        <Field label="MCap máx" value={mcapMax} onChange={(v) => { setLimit(PAGE_SIZE); setMcapMax(v); }} />
        <Field label="Liq mín" value={liqMin} onChange={(v) => { setLimit(PAGE_SIZE); setLiqMin(v); }} />
        <Field label="Edad máx (min)" value={maxAge} onChange={(v) => { setLimit(PAGE_SIZE); setMaxAge(v); }} />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void save()} disabled={!canSave}
            className="rounded border border-emerald-600 px-3 py-1 text-xs text-emerald-300 enabled:hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-600"
            title={saveHint}
          >
            Guardar en reglas
          </button>
          {email === null && <Link href="/login" className="text-[11px] text-zinc-500 underline">iniciar sesión</Link>}
          {isAdmin === false && email && <span className="text-[11px] text-zinc-600">sin permiso de edición</span>}
          {msg && <span className="text-[11px] text-zinc-400">{msg}</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 py-2 text-xs">
        {STATUSES.map((s) => (
          <button
            key={s.key} onClick={() => toggle(s.key)}
            className={`rounded border px-2 py-0.5 ${on.has(s.key) ? "border-zinc-500 bg-zinc-800 text-zinc-100" : "border-zinc-800 text-zinc-600"}`}
          >
            {s.label}
          </button>
        ))}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-300">
          <option value="status">Orden: veredicto, luego más nuevos</option>
          <option value="age">Orden: más nuevo</option>
          <option value="mcap">Orden: MCap</option>
          <option value="momentum">Orden: compras 5m</option>
        </select>
        <span className="text-zinc-500">{pending ? "actualizando…" : `${rows.length} de ${total}`}</span>
      </div>

      <div className={`hidden border-b border-zinc-800 pb-1 text-[10px] uppercase tracking-wide text-zinc-500 ${GRID}`}>
        <span>Token</span><span>Edad</span><span>MCap</span><span>Liq</span><span>Liq/MC</span><span>Momentum</span><span>Top10</span><span>Insiders</span><span>Veredicto</span>
      </div>

      {rows.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">Ningún token cumple estos filtros.</p>}

      <ul className={pending ? "opacity-60 transition-opacity" : ""}>
        {rows.map((r) => {
          const v = verdictOf(r);
          const ins = r.insiders_pct;
          return (
            <li key={r.mint} className="border-b border-zinc-900">
              <Link href={`/token/${r.mint}`} prefetch={false} className={`block py-2 text-sm hover:bg-zinc-900/60 ${GRID}`}>
                <div className="flex items-center justify-between gap-2 md:block">
                  <div className="min-w-0">
                    <span className="font-semibold text-zinc-100">{r.symbol ?? "?"}</span>
                    <span className="ml-1.5 text-[10px] text-zinc-600">{r.dex}</span>
                  </div>
                  <div className="md:hidden"><Badge {...v} /></div>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-300 md:contents">
                  <span title="Edad"><span className="text-zinc-600 md:hidden">edad </span>{fmtAge(r.age_min)}</span>
                  <span title="MCap"><span className="text-zinc-600 md:hidden">mc </span>{fmtUsd(r.mcap)}</span>
                  <span title="Liquidez"><span className="text-zinc-600 md:hidden">liq </span>{fmtUsd(r.liquidity_usd)}</span>
                  <span title="Liquidez / MCap" className="hidden md:inline">{r.liq_mcap_ratio == null ? "—" : r.liq_mcap_ratio.toFixed(2)}</span>
                  <span className="w-full md:w-auto"><Momentum m={r} /></span>
                  <span title="Top 10 sin lp/burn/locker" className={r.top10_pct != null && r.top10_pct > rules.top10_max_pct ? "text-red-400" : ""}>
                    <span className="text-zinc-600 md:hidden">top10 </span>{fmtPct(r.top10_pct)}
                  </span>
                  <span title={r.insider_evidence ? `Evidencia: ${r.insider_evidence}` : "Sin chequeo"} className={ins != null && ins > rules.insiders_max_pct ? "text-red-400" : ""}>
                    <span className="text-zinc-600 md:hidden">ins </span>{fmtPct(ins)}
                    {r.insider_evidence && r.insider_evidence !== "none" && <span className="ml-1 text-[9px] text-zinc-500">{r.insider_evidence === "strong" ? "●●" : "●"}</span>}
                  </span>
                </div>
                <div className="hidden md:block"><Badge {...v} /></div>
              </Link>
            </li>
          );
        })}
      </ul>

      {rows.length < total && (
        <div className="py-4 text-center">
          <button onClick={() => setLimit((l) => l + PAGE_SIZE)} className="rounded border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
            Cargar {Math.min(PAGE_SIZE, total - rows.length)} más ({total - rows.length} restantes)
          </button>
        </div>
      )}
    </div>
  );
}
