import { fmtPct, shortAddr } from "@/lib/format";
import type { Holder } from "@/lib/types";

const EXCLUDED = new Set(["lp", "burn", "locker"]);
const LABEL: Record<string, string> = { lp: "LP", burn: "quema", creator: "creador", exchange: "exchange", locker: "bloqueo", unknown: "" };

export default function HoldersPanel({ holders }: { holders: Holder[] }) {
  if (!holders.length) return <p className="text-sm text-zinc-500">Aún sin chequeo de holders (el token no ha sido candidato).</p>;

  const counted = holders.filter((h) => !EXCLUDED.has(h.label)).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const apart = holders.filter((h) => EXCLUDED.has(h.label));
  const top1 = counted[0]?.pct ?? 0;
  const top2to10 = counted.slice(1, 10).reduce((s, h) => s + (h.pct ?? 0), 0);
  const apartPct = apart.reduce((s, h) => s + (h.pct ?? 0), 0);
  const rest = Math.max(0, 100 - top1 - top2to10 - apartPct);

  const segs = [
    { name: "Top 1", v: top1, cls: "bg-red-500" },
    { name: "Top 2–10", v: top2to10, cls: "bg-amber-500" },
    { name: "Resto", v: rest, cls: "bg-emerald-600" },
  ];

  return (
    <div className="space-y-3">
      <div>
        <div className="flex h-4 overflow-hidden rounded bg-zinc-800">
          {segs.map((s) => <div key={s.name} className={s.cls} style={{ width: `${Math.min(100, s.v)}%` }} title={`${s.name}: ${fmtPct(s.v)}`} />)}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
          {segs.map((s) => (
            <span key={s.name} className="flex items-center gap-1 text-zinc-300">
              <span className={`h-2 w-2 rounded-sm ${s.cls}`} />{s.name} {fmtPct(s.v)}
            </span>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">
          Aparte (no cuentan): {apart.length ? apart.map((h) => `${LABEL[h.label]} ${fmtPct(h.pct)}`).join(" · ") : "ninguna en el top 20"}
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
            <tr><th className="py-1 pr-2">#</th><th className="pr-2">Wallet</th><th className="pr-2 text-right">%</th><th className="pr-2">Etiqueta</th><th>Insider</th></tr>
          </thead>
          <tbody>
            {holders.map((h) => {
              const excluded = EXCLUDED.has(h.label);
              return (
                <tr key={h.rank} className={`border-t border-zinc-900 ${excluded ? "text-zinc-500" : "text-zinc-200"}`}>
                  <td className="py-1 pr-2 text-zinc-600">{h.rank}</td>
                  <td className="pr-2">
                    {h.owner ? <a href={`https://solscan.io/account/${h.owner}`} target="_blank" rel="noreferrer" className="hover:text-white hover:underline">{shortAddr(h.owner)}</a> : "—"}
                  </td>
                  <td className="pr-2 text-right">{fmtPct(h.pct, 2)}</td>
                  <td className="pr-2">{LABEL[h.label] || "—"}{excluded ? " (aparte)" : ""}</td>
                  <td>{h.is_insider ? <span className="text-amber-400">insider</span> : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
