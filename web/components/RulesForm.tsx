"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import { useSessionEmail } from "@/lib/useSession";
import type { Rules } from "@/lib/types";

const FIELDS: { key: keyof Rules; label: string; help: string }[] = [
  { key: "mcap_min", label: "MCap mínimo (USD)", help: "Bajo este MCap el token no es candidato." },
  { key: "mcap_max", label: "MCap máximo (USD)", help: "Sobre este MCap el token no es candidato." },
  { key: "liq_min", label: "Liquidez mínima (USD)", help: "Si se conoce la liquidez, debe ser al menos esto." },
  { key: "liq_mcap_ratio_min", label: "Liquidez / MCap mínimo", help: "Ej. 0.05 = la liquidez es el 5 % del MCap." },
  { key: "max_age_min", label: "Edad máxima (min)", help: "Pasada esta edad deja de ser candidato." },
  { key: "buy_ratio_min", label: "Compras 5m mínimo (0–1)", help: "Proporción de compras sobre el total de operaciones en 5 min." },
  { key: "top10_max_pct", label: "Top 10 máximo (%)", help: "Sin contar LP, quema ni contratos de bloqueo. Sobre esto se descarta." },
  { key: "insiders_max_pct", label: "Insiders máximo (% supply)", help: "Sobre esto se descarta." },
  { key: "lp_locked_min_pct", label: "LP bloqueada mínima (%)", help: "Bajo esto se descarta (no aplica a la bonding curve de pump.fun)." },
  { key: "dead_liq_min", label: "Liquidez mínima de vida (USD)", help: "Bajo esto el token pasa a «muerto» y deja de seguirse." },
];

export default function RulesForm({ rules }: { rules: Rules }) {
  const router = useRouter();
  const email = useSessionEmail();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(rules[f.key])])));
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const sb = getBrowserSupabase();
    if (!sb) return;
    const patch: Record<string, number | string> = { updated_at: new Date().toISOString() };
    for (const f of FIELDS) {
      const n = Number(vals[f.key]);
      if (vals[f.key].trim() === "" || Number.isNaN(n)) { setMsg(`«${f.label}» no es un número válido.`); return; }
      patch[f.key] = n;
    }
    setSaving(true);
    const { error } = await sb.from("rules").update(patch).eq("id", 1);
    setSaving(false);
    setMsg(error ? `Error: ${error.message}` : "Reglas guardadas. Se aplican en la próxima ejecución del recolector.");
    if (!error) router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-xs text-zinc-300">{f.label}</span>
            <input
              inputMode="decimal" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500"
            />
            <span className="text-[11px] text-zinc-500">{f.help}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void save()} disabled={!email || saving}
          className="rounded border border-emerald-600 px-4 py-1.5 text-sm text-emerald-300 enabled:hover:bg-emerald-600/20 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:text-zinc-600"
        >
          {saving ? "Guardando…" : "Guardar reglas"}
        </button>
        {email === null && <span className="text-xs text-zinc-500">Solo un usuario autenticado puede editar. <Link href="/login" className="underline">Iniciar sesión</Link></span>}
        {msg && <span className="text-xs text-zinc-300">{msg}</span>}
      </div>
    </div>
  );
}
