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
  const { run, riskTs } = health;
  const age = minutesSince(run?.ts);
  const tone = age == null ? "bg-red-500" : age <= 3 && !run?.errors ? "bg-emerald-500" : age <= 10 ? "bg-amber-500" : "bg-red-500";
  const riskAge = minutesSince(riskTs);
  return (
    <span className="flex items-center gap-2 text-xs text-zinc-400" title={run ? `Último run: ${run.tokens_seen} tokens, ${run.snapshots_saved} snapshots, ${run.errors} errores` : "Sin ejecuciones"}>
      <span className={`h-2 w-2 rounded-full ${tone}`} />
      <span>recolector {age == null ? "sin datos" : `hace ${age}m`}</span>
      <span className="hidden sm:inline text-zinc-600">· riesgo {riskAge == null ? "—" : `hace ${riskAge}m`}</span>
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
