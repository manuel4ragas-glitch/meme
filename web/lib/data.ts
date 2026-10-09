import { connection } from "next/server";
import type { FeedQuery } from "./feedQuery";
import { getSupabase } from "./supabase";
import type { AgeCohort, FeedRow, Holder, OutcomeSummary, RiskCheck, Rules, Signal, Snapshot } from "./types";

async function db() {
  await connection(); // lectura en vivo: nunca se prerenderiza ni se cachea
  const sb = getSupabase();
  if (!sb) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return sb;
}

function ok<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export async function getRules(): Promise<Rules> {
  const sb = await db();
  return ok(await sb.from("rules").select("*").eq("id", 1).single());
}

// Filtra, ordena y limita en la consulta (no en el navegador). `total` = filas que cumplen los filtros.
export async function getFeed(q: FeedQuery): Promise<{ rows: FeedRow[]; total: number }> {
  const sb = await db();
  if (!q.statuses.length) return { rows: [], total: 0 };
  let query = sb.from("token_feed").select("*", { count: "exact" }).in("status", q.statuses);
  if (q.mcapMin != null) query = query.gte("mcap", q.mcapMin);
  if (q.mcapMax != null) query = query.lte("mcap", q.mcapMax);
  // liquidez desconocida (pares pumpfun) no se excluye: igual que el recolector
  if (q.liqMin != null) query = query.or(`liquidity_usd.is.null,liquidity_usd.gte.${q.liqMin}`);
  if (q.maxAge != null) query = query.lte("age_min", q.maxAge);

  if (q.sort === "mcap") query = query.order("mcap", { ascending: false, nullsFirst: false });
  else if (q.sort === "momentum") query = query.order("buy_ratio_m5", { ascending: false, nullsFirst: false }).order("age_min", { ascending: true });
  else if (q.sort === "age") query = query.order("age_min", { ascending: true });
  else query = query.order("status_rank", { ascending: true }).order("age_min", { ascending: true }); // alertas y candidatos primero, luego los más nuevos

  const res = await query.limit(q.limit);
  if (res.error) throw new Error(res.error.message);
  return { rows: (res.data ?? []) as FeedRow[], total: res.count ?? res.data?.length ?? 0 };
}

export async function getHealth() {
  const sb = await db();
  const [run, risk, rules] = await Promise.all([
    sb.from("collector_runs").select("ts, tokens_seen, snapshots_saved, errors, db_size_mb, error_detail").order("ts", { ascending: false }).limit(1).maybeSingle(),
    sb.from("risk_checks").select("ts").order("ts", { ascending: false }).limit(1).maybeSingle(),
    sb.from("rules").select("db_max_mb").eq("id", 1).maybeSingle(),
  ]);
  return { run: run.data, riskTs: risk.data?.ts ?? null, dbMaxMb: rules.data?.db_max_mb ?? null, error: run.error?.message ?? null };
}

export async function getToken(mint: string) {
  const sb = await db();
  const [token, snaps, checks, holders, signals] = await Promise.all([
    sb.from("tokens").select("mint, symbol, name, dex, status, pair_address, creator, pair_created_at, first_seen_at").eq("mint", mint).maybeSingle(),
    sb.from("market_snapshots").select("ts, price_usd, mcap, liquidity_usd, volume_m5, volume_h1, buys_m5, sells_m5, buys_h1, sells_h1, price_change_m5, price_change_h1")
      .eq("mint", mint).order("ts", { ascending: false }).limit(1500),
    sb.from("risk_checks").select("*").eq("mint", mint).order("ts", { ascending: true }),
    sb.from("holder_snapshots").select("ts, rank, owner, pct, is_insider, label").eq("mint", mint).order("ts", { ascending: false }).limit(100),
    sb.from("signals").select("id, ts, verdict, reasons, data, mint").eq("mint", mint).order("ts", { ascending: false }).limit(20),
  ]);
  for (const r of [token, snaps, checks, holders, signals]) if (r.error) throw new Error(r.error.message);
  return {
    token: token.data as { mint: string; symbol: string | null; name: string | null; dex: string | null; status: FeedRow["status"]; pair_address: string | null; creator: string | null; pair_created_at: string | null; first_seen_at: string } | null,
    snapshots: ((snaps.data ?? []) as Snapshot[]).reverse(),
    checks: (checks.data ?? []) as RiskCheck[],
    holders: (holders.data ?? []) as Holder[],
    signals: (signals.data ?? []) as Signal[],
  };
}

export async function getRecentSignals(limit = 150): Promise<Signal[]> {
  const sb = await db();
  const res = await sb.from("signals").select("id, ts, verdict, reasons, data, mint, tokens(symbol, name)").neq("verdict", "dead").order("ts", { ascending: false }).limit(limit);
  return ok(res) as unknown as Signal[];
}

export async function getResults() {
  const sb = await db();
  const [summary, cohorts, total, complete] = await Promise.all([
    sb.from("outcome_summary").select("*").order("verdict").order("age_bucket"),
    sb.from("age_cohorts").select("*").order("cohort"),
    sb.from("token_outcomes").select("signal_id", { count: "exact", head: true }),
    sb.from("token_outcomes").select("signal_id", { count: "exact", head: true }).eq("complete", true),
  ]);
  for (const r of [summary, cohorts]) if (r.error) throw new Error(r.error.message);
  return {
    summary: (summary.data ?? []) as OutcomeSummary[],
    cohorts: (cohorts.data ?? []) as AgeCohort[],
    total: total.count ?? 0,
    complete: complete.count ?? 0,
  };
}
