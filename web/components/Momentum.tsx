import { buyRatio, fmtSigned, volumeSpike } from "@/lib/format";

function Bar({ label, buys, sells }: { label: string; buys: number | null; sells: number | null }) {
  const r = buyRatio(buys, sells);
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${buys ?? 0} compras / ${sells ?? 0} ventas`}>
      <span className="w-5 text-[10px] text-zinc-500">{label}</span>
      <div className="flex h-1.5 w-20 overflow-hidden rounded-sm bg-zinc-800">
        {r != null && (
          <>
            <div className="bg-emerald-500" style={{ width: `${r * 100}%` }} />
            <div className="bg-red-500" style={{ width: `${(1 - r) * 100}%` }} />
          </>
        )}
      </div>
      <span className={`w-8 text-right text-[10px] ${r == null ? "text-zinc-600" : r >= 0.5 ? "text-emerald-400" : "text-red-400"}`}>
        {r == null ? "—" : `${Math.round(r * 100)}%`}
      </span>
    </div>
  );
}

type M = {
  buys_m5: number | null; sells_m5: number | null; buys_h1: number | null; sells_h1: number | null;
  volume_m5: number | null; volume_h1: number | null; price_change_m5: number | null; price_change_h1: number | null;
};

export default function Momentum({ m, detailed = false }: { m: M; detailed?: boolean }) {
  const spike = volumeSpike(m.volume_m5, m.volume_h1);
  const up = (n: number | null) => (n == null ? "text-zinc-500" : n >= 0 ? "text-emerald-400" : "text-red-400");
  return (
    <div className="space-y-0.5">
      <Bar label="5m" buys={m.buys_m5} sells={m.sells_m5} />
      <Bar label="1h" buys={m.buys_h1} sells={m.sells_h1} />
      <div className="flex gap-2 text-[10px] text-zinc-500">
        <span title="Volumen de 5 min frente al promedio de 5 min de la última hora">vol {spike == null ? "—" : `×${spike.toFixed(1)}`}</span>
        <span className={up(m.price_change_m5)}>{fmtSigned(m.price_change_m5)} 5m</span>
        {detailed && <span className={up(m.price_change_h1)}>{fmtSigned(m.price_change_h1)} 1h</span>}
      </div>
    </div>
  );
}
