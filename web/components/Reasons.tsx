import type { Reason } from "@/lib/types";

const NAMES: Record<string, string> = {
  edad_max_min: "Edad máxima (min)", mcap: "MCap en rango", liquidez_min: "Liquidez mínima", liq_mcap_ratio: "Liquidez / MCap",
  compras_m5: "Compras 5m", rugged: "Rugged", mint_authority_activa: "Mint authority activa", freeze_authority_activa: "Freeze authority activa",
  top10_pct: "Top 10 (%)", insiders_pct: "Insiders (%)", lp_bloqueada_pct: "LP bloqueada (%)",
  liquidez_verificada: "Liquidez verificada", liquidez_rugcheck_min: "Liquidez (RugCheck)", riesgo_sin_verificar: "Riesgo sin verificar",
};

function val(v: Reason["value"]): string {
  if (v == null) return "sin dato";
  if (typeof v === "boolean") return v ? "sí" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return v;
}

export default function Reasons({ reasons }: { reasons: Reason[] | string[] }) {
  if (!reasons?.length) return <p className="text-xs text-zinc-500">Sin motivos registrados.</p>;
  return (
    <ul className="space-y-0.5 text-xs">
      {reasons.map((r, i) => {
        if (typeof r === "string") return <li key={i} className="text-zinc-300">• {r}</li>;
        return (
          <li key={i} className="flex gap-2">
            <span className={r.ok ? "text-emerald-400" : "text-red-400"}>{r.ok ? "✓" : "✗"}</span>
            <span className="text-zinc-300">{NAMES[r.rule] ?? r.rule}</span>
            <span className="text-zinc-500">{val(r.value)}{r.limit != null ? ` (límite ${r.limit})` : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}
