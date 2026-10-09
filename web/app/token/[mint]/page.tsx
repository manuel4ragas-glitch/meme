import Link from "next/link";
import { Suspense } from "react";
import AutoRefresh from "@/components/AutoRefresh";
import Badge from "@/components/Badge";
import HoldersPanel from "@/components/HoldersPanel";
import LineChart from "@/components/LineChart";
import Momentum from "@/components/Momentum";
import Reasons from "@/components/Reasons";
import { getToken } from "@/lib/data";
import { ageMinutes, fmtAge, fmtPct, fmtTime, fmtUsd } from "@/lib/format";
import { verdictOf } from "@/lib/verdict";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-zinc-800 bg-zinc-900/30 p-3">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-sm ${tone ?? "text-zinc-100"}`}>{value}</div>
    </div>
  );
}

const authority = (active: boolean | null) => (active == null ? "—" : active ? "ACTIVA" : "revocada");

async function TokenView({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  let data;
  try {
    data = await getToken(mint);
  } catch (e) {
    return <p className="text-sm text-red-400">No se pudo leer Supabase: {e instanceof Error ? e.message : String(e)}</p>;
  }
  const { token, snapshots, checks, holders, signals } = data;
  if (!token) return <p className="text-sm text-zinc-400">Token no encontrado. <Link href="/" className="underline">Volver al feed</Link></p>;

  const snap = snapshots[snapshots.length - 1];
  const okChecks = checks.filter((c) => c.status === "ok");
  const risk = okChecks[okChecks.length - 1];
  const lastCheck = checks[checks.length - 1];
  const created = token.pair_created_at ?? token.first_seen_at;
  const ageMin = ageMinutes(created);
  const v = verdictOf({ status: token.status, risk_last_status: lastCheck?.status ?? null, risk_ts: risk?.ts ?? null });

  const latestHolderTs = holders[0]?.ts;
  const holderRows = holders.filter((h) => h.ts === latestHolderTs).sort((a, b) => a.rank - b.rank);
  const signal = signals[0];
  const missing = signal?.data?.datos_faltantes ?? [];
  const unverifiedCount = checks.filter((c) => c.status === "unverified").length;
  const t = (s: string) => new Date(s).getTime();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-200">← feed</Link>
        <h1 className="text-lg font-semibold text-zinc-100">{token.symbol ?? "?"}</h1>
        <span className="text-xs text-zinc-500">{token.name}</span>
        <Badge {...v} />
        <span className="text-[11px] text-zinc-500">{token.dex} · edad {fmtAge(ageMin)}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
        <span className="break-all">{token.mint}</span>
        <a className="underline hover:text-zinc-200" target="_blank" rel="noreferrer" href={`https://dexscreener.com/solana/${token.pair_address ?? token.mint}`}>DexScreener</a>
        <a className="underline hover:text-zinc-200" target="_blank" rel="noreferrer" href={`https://rugcheck.xyz/tokens/${token.mint}`}>RugCheck</a>
      </div>

      <Card title="Mercado">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="MCap" value={fmtUsd(snap?.mcap)} />
          <Stat label="Liquidez" value={fmtUsd(snap?.liquidity_usd)} />
          <Stat label="Liq / MCap" value={snap?.mcap && snap.liquidity_usd != null ? (snap.liquidity_usd / snap.mcap).toFixed(2) : "—"} />
          <Stat label="Vol 1h" value={fmtUsd(snap?.volume_h1)} />
          <Stat label="Precio" value={fmtUsd(snap?.price_usd)} />
          <Stat label="Último snapshot" value={fmtTime(snap?.ts)} />
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <LineChart title="MCap" color="#34d399" points={snapshots.map((s) => ({ t: t(s.ts), v: s.mcap }))} format={fmtUsd} />
          <LineChart title="Liquidez" color="#60a5fa" points={snapshots.map((s) => ({ t: t(s.ts), v: s.liquidity_usd }))} format={fmtUsd} />
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Momentum">
          {snap ? <Momentum m={snap} detailed /> : <p className="text-sm text-zinc-500">Sin snapshots.</p>}
          {snap && <p className="mt-2 text-[11px] text-zinc-500">Compras vs. ventas en 5 min y 1 h. «vol ×N» compara el volumen de 5 min con el promedio por 5 min de la última hora.</p>}
        </Card>

        <Card title="Seguridad">
          {!risk ? (
            <p className="text-sm text-zinc-500">{lastCheck ? "El último chequeo no se pudo verificar (RugCheck falló o limitó)." : "Aún no hay chequeo de riesgo: el token no ha llegado a candidato."}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Mint authority" value={authority(risk.mint_authority_active)} tone={risk.mint_authority_active ? "text-red-400" : "text-emerald-400"} />
                <Stat label="Freeze authority" value={authority(risk.freeze_authority_active)} tone={risk.freeze_authority_active ? "text-red-400" : "text-emerald-400"} />
                <Stat label="LP bloqueada" value={risk.lp_locked_pct == null ? "n/a (bonding curve)" : fmtPct(risk.lp_locked_pct)} />
                <Stat label="Score (0 bueno)" value={risk.score_normalised == null ? "—" : String(risk.score_normalised)} />
                <Stat label="Rugged" value={risk.rugged ? "SÍ" : "no"} tone={risk.rugged ? "text-red-400" : undefined} />
                <Stat label="Holders totales" value={risk.total_holders == null ? "—" : String(risk.total_holders)} />
              </div>
              <ul className="mt-2 space-y-0.5 text-xs">
                {risk.risks?.length ? risk.risks.map((r, i) => <li key={i} className="text-amber-300">⚠ {r.name}{r.description ? ` — ${r.description}` : ""}</li>) : <li className="text-zinc-500">RugCheck no reporta riesgos.</li>}
              </ul>
              <p className="mt-2 text-[11px] text-zinc-500">Chequeo de {fmtTime(risk.ts)}.</p>
            </>
          )}
        </Card>
      </div>

      <Card title="Distribución de holders">
        <HoldersPanel holders={holderRows} />
      </Card>

      <Card title="Insiders">
        {!okChecks.length ? <p className="text-sm text-zinc-500">Sin chequeos verificados.</p> : (
          <>
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                <tr><th className="py-1">Chequeo</th><th className="text-right">Wallets</th><th className="text-right">% supply</th><th className="pl-4">Evidencia</th></tr>
              </thead>
              <tbody>
                {okChecks.map((c, i) => (
                  <tr key={c.ts} className="border-t border-zinc-900 text-zinc-200">
                    <td className="py-1">#{i + 1} · {fmtTime(c.ts)}</td>
                    <td className="text-right">{c.insiders_count ?? "—"}</td>
                    <td className="text-right">{fmtPct(c.insiders_pct, 2)}</td>
                    <td className="pl-4">{c.insider_evidence === "strong" ? "fuerte" : c.insider_evidence === "weak" ? "débil" : "ninguna"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-zinc-500">Los insiders son una señal, no una prueba: un grupo de wallets relacionadas no demuestra una estafa. El % no excluye pool/quema dentro de las redes.</p>
          </>
        )}
      </Card>

      <Card title="Motivos del veredicto">
        {signal ? (
          <>
            <p className="mb-1 text-[11px] text-zinc-500">Último cambio: <b className="text-zinc-300">{signal.verdict}</b> · {fmtTime(signal.ts)}</p>
            <Reasons reasons={signal.reasons} />
          </>
        ) : <p className="text-sm text-zinc-500">Sin señales registradas.</p>}
        <div className="mt-2 space-y-0.5 text-[11px] text-zinc-500">
          {missing.length > 0 && <p>Datos faltantes: {missing.join(", ")}.</p>}
          {unverifiedCount > 0 && <p>{unverifiedCount} chequeo(s) sin verificar. Un token sin verificar nunca se muestra como aprobado.</p>}
          {signals.length > 1 && <p>{signals.length} señales en total (historial en la página Señales).</p>}
        </div>
      </Card>
    </div>
  );
}

export default function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  return (
    <main className="mx-auto w-full max-w-5xl px-3 py-3 font-mono">
      <Suspense fallback={<p className="text-sm text-zinc-500">Cargando token…</p>}>
        <TokenView params={params} />
      </Suspense>
      <AutoRefresh seconds={30} />
    </main>
  );
}
