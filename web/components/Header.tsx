import Link from "next/link";
import { Suspense } from "react";
import { getHealth } from "@/lib/data";
import { minutesSince } from "@/lib/format";
import AuthButton from "./AuthButton";

async function Health() {
  let health;
  try {
    health = await getHealth();
  } catch {
    return <span className="flex items-center gap-2 text-xs text-red-400"><span className="h-2 w-2 rounded-full bg-red-500" />sin conexión</span>;
  }
  const { run, riskTs, dbMaxMb, queueLastHour: q } = health;
  const age = minutesSince(run?.ts);
  const tone = age == null ? "bg-red-500" : age <= 3 && !run?.errors ? "bg-emerald-500" : age <= 10 ? "bg-amber-500" : "bg-red-500";
  const riskAge = minutesSince(riskTs);
  const dbMb = run?.db_size_mb != null ? Number(run.db_size_mb) : null;
  const dbRatio = dbMb != null && dbMaxMb ? dbMb / dbMaxMb : null;
  const dbTone = dbRatio == null ? "text-zinc-600" : dbRatio >= 1 ? "text-red-400" : dbRatio >= 0.8 ? "text-amber-400" : "text-zinc-500";
  const paused = Array.isArray(run?.error_detail) && run.error_detail.some((e: { source?: string }) => e.source === "db_size");
  return (
    <span className="flex items-center gap-2 text-xs text-zinc-400" title={run ? `Último run: ${run.tokens_seen} tokens, ${run.snapshots_saved} snapshots, ${run.errors} errores` : "Sin ejecuciones"}>
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      <span>recolector {age == null ? "sin datos" : `hace ${age}m`}</span>
      <span className="hidden sm:inline text-zinc-600">· riesgo {riskAge == null ? "—" : `hace ${riskAge}m`}</span>
      <span className={`hidden sm:inline ${dbTone}`} title="Tamaño de la base frente al límite que frena el descubrimiento">
        · base {dbMb == null ? "—" : `${Math.round(dbMb)}${dbMaxMb ? `/${dbMaxMb}` : ""} MB`}
      </span>
      <span className="hidden md:inline text-zinc-500" title="Cola de lanzamientos: tokens esperando cumplir las reglas. Última hora: entraron / promovidos a seguimiento / descartados">
        · cola {run?.queue_size ?? "—"} <span className="text-zinc-600">(1h: +{q.queued} ✓{q.promoted} ✗{q.dropped})</span>
      </span>
      {paused && <span className="text-red-400">promoción pausada</span>}
    </span>
  );
}

const nav = [
  { href: "/", label: "Feed" },
  { href: "/signals", label: "Señales" },
  { href: "/results", label: "Resultados" },
  { href: "/rules", label: "Reglas" },
];

export default function Header() {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-1 px-3 py-2 font-mono">
        <Link href="/" className="text-sm font-semibold text-emerald-400">SOL·MEME</Link>
        <nav className="flex gap-4 text-sm">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} prefetch={false} className="text-zinc-300 hover:text-white">{n.label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <Suspense fallback={<span className="text-xs text-zinc-600">…</span>}>
            <Health />
          </Suspense>
          <AuthButton />
        </div>
      </div>
    </header>
  );
}
