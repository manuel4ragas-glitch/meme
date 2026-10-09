type Point = { t: number; v: number | null };

const W = 600, H = 150, PL = 54, PR = 8, PT = 8, PB = 18;

function hhmm(t: number) {
  return new Date(t).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function LineChart({ title, points, color, format }: { title: string; points: Point[]; color: string; format: (n: number) => string }) {
  const valid = points.filter((p): p is { t: number; v: number } => p.v != null);
  return (
    <figure className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <figcaption className="flex justify-between px-1 text-[11px] text-zinc-400">
        <span>{title}</span>
        <span className="text-zinc-200">{valid.length ? format(valid[valid.length - 1].v) : "sin datos"}</span>
      </figcaption>
      {valid.length < 2 ? (
        <p className="py-8 text-center text-xs text-zinc-600">{valid.length === 0 ? "Sin datos para este gráfico." : "Aún hay un solo punto."}</p>
      ) : (() => {
        const t0 = valid[0].t, t1 = valid[valid.length - 1].t;
        const vmin = Math.min(...valid.map((p) => p.v)), vmax = Math.max(...valid.map((p) => p.v));
        const span = vmax - vmin || Math.abs(vmax) || 1;
        const x = (t: number) => PL + ((t - t0) / (t1 - t0 || 1)) * (W - PL - PR);
        const y = (v: number) => PT + (1 - (v - vmin) / span) * (H - PT - PB);
        let d = "";
        let pen = false;
        for (const p of points) {
          if (p.v == null) { pen = false; continue; }
          d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
          pen = true;
        }
        const ticks = [vmin, vmin + span / 2, vmax];
        return (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title}>
            {ticks.map((v, i) => (
              <g key={i}>
                <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="#27272a" strokeWidth="1" />
                <text x={PL - 4} y={y(v) + 3} textAnchor="end" fontSize="10" fill="#71717a">{format(v)}</text>
              </g>
            ))}
            <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
            <text x={PL} y={H - 4} fontSize="10" fill="#71717a">{hhmm(t0)}</text>
            <text x={W - PR} y={H - 4} textAnchor="end" fontSize="10" fill="#71717a">{hhmm(t1)}</text>
          </svg>
        );
      })()}
    </figure>
  );
}
