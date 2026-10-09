"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { buyRatio, fmtAge, fmtPct, fmtUsd } from "@/lib/format";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { useSessionEmail } from "@/lib/useSession";
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
const ORDER: Record<string, number> = { alert: 0, candidate: 1, discarded: 2, tracking: 3 };
const GRID = "md:grid md:grid-cols-[1.3fr_.5fr_.8fr_.8fr_.6fr_1.5fr_.6fr_.8fr_1fr] md:items-center md:gap-2";

const num = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
};

type Sort = "status" | "age" | "mcap" | "momentum";

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
      {label}
      <input
        inputMode="decimal" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-sm normal-case text-zinc-100 outline-none focus:border-emerald-500"
      />
    </label>
  );
}

export default function FeedClient({ rows, rules }: { rows: FeedRow[]; rules: Rules }) {
  const router = useRouter();
  const email = useSessionEmail();
  const [mcapMin, setMcapMin] = useState(String(rules.mcap_min));
  const [mcapMax, setMcapMax] = useState(String(rules.mcap_max));
  const [liqMin, setLiqMin] = useState(String(rules.liq_min));
  const [maxAge, setMaxAge] = useState(String(rules.max_age_min));
  const [on, setOn] = useState<Set<Status>>(new Set(["alert", "candidate", "discarded"]));
  const [sort, setSort] = useState<Sort>("status");
  const [msg, setMsg] = useState<string | null>(null);

  const shown = useMemo(() => {
    const lo = num(mcapMin), hi = num(mcapMax), liq = num(liqMin), age = num(maxAge);
    const list = rows.filter((r) => {
      if (!on.has(r.status)) return false;
      if (lo != null && (r.mcap == null || r.mcap < lo)) return false;
      if (hi != null && (r.mcap == null || r.mcap > hi)) return false;
      if (liq != null && r.liquidity_usd != null && r.liquidity_usd < liq) return false;
      if (age != null && r.age_min != null && r.age_min > age) return false;
      return true;
    });
    const mom = (r: FeedRow) => buyRatio(r.buys_m5, r.sells_m5) ?? -1;
    list.sort((a, b) => {
      if (sort === "age") return (a.age_min ?? 1e9) - (b.age_min ?? 1e9);
      if (sort === "mcap") return (b.mcap ?? 0) - (a.mcap ?? 0);
      if (sort === "momentum") return mom(b) - mom(a);
      return (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (a.age_min ?? 1e9) - (b.age_min ?? 1e9);
    });
    return list;
  }, [rows, on, mcapMin, mcapMax, liqMin, maxAge, sort]);

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

  const toggle = (s: Status) => setOn((prev) => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });

  return (
    <div className="font-mono">
      <div className="flex flex-wrap items-end gap-3 border-b border-zinc-800 pb-3">
        <Field label="MCap mín" value={mcapMin} onChange={setMcapMin} />
        <Field label="MCap máx" value={mcapMax} onChange={setMcapMax} />
        <Field label="Liq mín" value={liqMin} onChange={setLiqMin} />
        <Field label="Edad máx (min)" value={maxAge} onChange={setMaxAge} />
        <div className="flex items-center gap-2">
          <button
            onClick={() => void save()} disabled={!email}
            className="rounded border border-emerald-600 px-3 py-1 text-xs text-emerald-300 enabled:hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-600"
            title={email ? "Guarda estos valores en la tabla rules" : "Inicia sesión para guardar"}
          >
            Guardar en reglas
          </button>
          {email === null && <Link href="/login" className="text-[11px] text-zinc-500 underline">iniciar sesión</Link>}
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
          <option value="status">Orden: veredicto</option>
          <option value="age">Orden: más nuevo</option>
          <option value="mcap">Orden: MCap</option>
          <option value="momentum">Orden: compras 5m</option>
        </select>
        <span className="text-zinc-500">{shown.length} / {rows.length}</span>
      </div>

      <div className={`hidden border-b border-zinc-800 pb-1 text-[10px] uppercase tracking-wide text-zinc-500 ${GRID}`}>
        <span>Token</span><span>Edad</span><span>MCap</span><span>Liq</span><span>Liq/MC</span><span>Momentum</span><span>Top10</span><span>Insiders</span><span>Veredicto</span>
      </div>

      {shown.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">Ningún token cumple estos filtros.</p>}

      <ul>
        {shown.map((r) => {
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
    </div>
  );
}
