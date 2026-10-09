// Recolector: descubre tokens nuevos de Solana, guarda snapshots de mercado y aplica las reglas de mercado.
// Lo invoca pg_cron cada minuto. Una sola ejecución debe terminar muy por debajo del límite de la Edge Function.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "memes" }, auth: { persistSession: false } },
);

const TIME_BUDGET_MS = 45_000; // no se inician lotes nuevos pasado este tiempo
const BATCH_SIZE = 30; // máximo de direcciones por llamada a DexScreener (medido en docs/apis.md)
const MAX_DUE = 300; // tokens por ejecución; si hay más, el resto cae en la siguiente
const CONCURRENCY = 3;
const HOUR_MS = 3_600_000;

type Err = { source: string; message: string };
// deno-lint-ignore no-explicit-any
type Json = any;

async function fetchJson(url: string, retries = 2, timeoutMs = 8000): Promise<Json> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) return await res.json();
      // 429 y 5xx se reintentan; el resto de 4xx no tiene sentido repetirlo
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
      if (e instanceof Error && /^HTTP 4\d\d$/.test(e.message) && e.message !== "HTTP 429") throw e;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** i + Math.random() * 250));
  }
  throw last;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function discover(errors: Err[]): Promise<number> {
  const found = new Map<string, { mint: string; symbol?: string; creator?: string; source: string }>();
  const add = (mint: string, source: string, extra: { symbol?: string; creator?: string } = {}) => {
    if (mint && !found.has(mint)) found.set(mint, { mint, source, ...extra });
  };

  await Promise.all([
    (async () => {
      try {
        const list = await fetchJson("https://api.rugcheck.xyz/v1/stats/new_tokens");
        for (const t of list ?? []) add(t.mint, "rugcheck_new", { symbol: t.symbol, creator: t.creator || undefined });
      } catch (e) { errors.push({ source: "rugcheck_new", message: msg(e) }); }
    })(),
    (async () => {
      try {
        const list = await fetchJson("https://api.dexscreener.com/token-profiles/latest/v1");
        for (const t of list ?? []) if (t.chainId === "solana") add(t.tokenAddress, "dex_profile");
      } catch (e) { errors.push({ source: "dex_profile", message: msg(e) }); }
    })(),
    (async () => {
      try {
        const list = await fetchJson("https://api.dexscreener.com/token-boosts/latest/v1");
        for (const t of list ?? []) if (t.chainId === "solana") add(t.tokenAddress, "dex_boost");
      } catch (e) { errors.push({ source: "dex_boost", message: msg(e) }); }
    })(),
  ]);

  if (!found.size) return 0;
  // ignoreDuplicates = ON CONFLICT DO NOTHING: lo que ya existe no se toca; select() devuelve solo las filas nuevas
  const { data, error } = await db.from("tokens")
    .upsert([...found.values()], { onConflict: "mint", ignoreDuplicates: true })
    .select("mint");
  if (error) { errors.push({ source: "insert_tokens", message: error.message }); return 0; }
  return data?.length ?? 0;
}

// Frecuencia decreciente según la edad del par. null = el token ya está muerto.
function nextIntervalMin(ageMin: number): number | null {
  if (ageMin < 60) return 1;
  if (ageMin < 360) return 5;
  if (ageMin < 1440) return 15;
  return null;
}

function pickPair(pairs: Json[], mint: string): Json | null {
  const own = pairs.filter((p) => p.baseToken?.address === mint && p.chainId === "solana");
  if (!own.length) return null;
  // un token puede tener varios pares: gana el de mayor liquidez, y a igualdad el de mayor volumen
  own.sort((a, b) => (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1) || (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
  return own[0];
}

type Rules = {
  mcap_min: number; mcap_max: number; liq_min: number; liq_mcap_ratio_min: number;
  max_age_min: number; buy_ratio_min: number; dead_liq_min: number;
};
type Check = { rule: string; ok: boolean; value: number | null; limit: number | string };

function evaluate(s: Json, ageMin: number, r: Rules): { pass: boolean; checks: Check[]; missing: string[] } {
  const checks: Check[] = [];
  const missing: string[] = [];
  checks.push({ rule: "edad_max_min", ok: ageMin <= r.max_age_min, value: Math.round(ageMin), limit: r.max_age_min });
  checks.push({ rule: "mcap", ok: s.mcap != null && s.mcap >= r.mcap_min && s.mcap <= r.mcap_max, value: s.mcap, limit: `${r.mcap_min}-${r.mcap_max}` });
  if (s.liquidity_usd == null) {
    // los pares pumpfun no traen liquidez: no se bloquea por un dato que no existe, pero queda registrado
    missing.push("liquidity_usd");
  } else {
    checks.push({ rule: "liquidez_min", ok: s.liquidity_usd >= r.liq_min, value: s.liquidity_usd, limit: r.liq_min });
    const ratio = s.mcap ? s.liquidity_usd / s.mcap : null;
    checks.push({ rule: "liq_mcap_ratio", ok: ratio != null && ratio >= r.liq_mcap_ratio_min, value: ratio, limit: r.liq_mcap_ratio_min });
  }
  const tx = (s.buys_m5 ?? 0) + (s.sells_m5 ?? 0);
  const buyRatio = tx > 0 ? s.buys_m5 / tx : null;
  checks.push({ rule: "compras_m5", ok: buyRatio != null && buyRatio >= r.buy_ratio_min, value: buyRatio, limit: r.buy_ratio_min });
  return { pass: checks.every((c) => c.ok), checks, missing };
}

async function processBatch(batch: Json[], rules: Rules, tally: { saved: number }, errors: Err[]) {
  let pairs: Json[];
  try {
    pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.map((t) => t.mint).join(",")}`);
  } catch (e) {
    // los tokens quedan vencidos y se reintentan en la próxima ejecución
    errors.push({ source: "dex_tokens", message: msg(e) });
    return;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const snapshots: Json[] = [];
  const tokenRows: Json[] = [];
  const signals: Json[] = [];

  for (const t of batch) {
    const pair = pickPair(pairs ?? [], t.mint);
    if (!pair) {
      const sinceSeen = now.getTime() - new Date(t.first_seen_at).getTime();
      const dead = sinceSeen > 24 * HOUR_MS;
      tokenRows.push({ ...t, status: dead ? "dead" : t.status, next_snapshot_at: new Date(now.getTime() + 5 * 60_000).toISOString() });
      continue;
    }

    const s = {
      mint: t.mint, ts: nowIso,
      price_usd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
      mcap: pair.marketCap ?? null, fdv: pair.fdv ?? null,
      liquidity_usd: pair.liquidity?.usd ?? null,
      volume_m5: pair.volume?.m5 ?? null, volume_h1: pair.volume?.h1 ?? null,
      volume_h6: pair.volume?.h6 ?? null, volume_h24: pair.volume?.h24 ?? null,
      buys_m5: pair.txns?.m5?.buys ?? null, buys_h1: pair.txns?.h1?.buys ?? null,
      buys_h6: pair.txns?.h6?.buys ?? null, buys_h24: pair.txns?.h24?.buys ?? null,
      sells_m5: pair.txns?.m5?.sells ?? null, sells_h1: pair.txns?.h1?.sells ?? null,
      sells_h6: pair.txns?.h6?.sells ?? null, sells_h24: pair.txns?.h24?.sells ?? null,
      price_change_m5: pair.priceChange?.m5 ?? null, price_change_h1: pair.priceChange?.h1 ?? null,
    };
    snapshots.push(s);

    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date(t.first_seen_at);
    const ageMin = (now.getTime() - createdAt.getTime()) / 60_000;

    const interval = nextIntervalMin(ageMin);
    const h1Tx = (s.buys_h1 ?? 0) + (s.sells_h1 ?? 0);
    let deadReason: string | null = null;
    if (interval === null) deadReason = "edad > 24 h";
    else if (s.liquidity_usd != null && s.liquidity_usd < rules.dead_liq_min) deadReason = "liquidez bajo el mínimo";
    else if (ageMin >= 60 && h1Tx === 0) deadReason = "sin transacciones en 1 h";

    let status: string = t.status;
    if (deadReason) {
      status = "dead";
      signals.push({ mint: t.mint, ts: nowIso, verdict: "dead", reasons: [deadReason], data: { mcap: s.mcap, liquidity_usd: s.liquidity_usd } });
    } else if (t.status === "tracking" || t.status === "candidate") {
      // 'alert' y 'discarded' los decide la función de riesgo; el recolector no los degrada
      const ev = evaluate(s, ageMin, rules);
      status = ev.pass ? "candidate" : "tracking";
      if (status !== t.status) {
        signals.push({
          mint: t.mint, ts: nowIso, verdict: status, reasons: ev.checks,
          data: { mcap: s.mcap, liquidity_usd: s.liquidity_usd, age_min: Math.round(ageMin), datos_faltantes: ev.missing },
        });
      }
    }

    tokenRows.push({
      ...t, status,
      symbol: pair.baseToken?.symbol ?? t.symbol, name: pair.baseToken?.name ?? t.name,
      pair_address: pair.pairAddress, dex: pair.dexId, pair_created_at: createdAt.toISOString(),
      next_snapshot_at: new Date(now.getTime() + (interval ?? 1440) * 60_000).toISOString(),
    });
  }

  if (snapshots.length) {
    const { error } = await db.from("market_snapshots").upsert(snapshots, { onConflict: "mint,ts", ignoreDuplicates: true });
    if (error) errors.push({ source: "insert_snapshots", message: error.message });
    else tally.saved += snapshots.length;
  }
  if (tokenRows.length) {
    const { error } = await db.from("tokens").upsert(tokenRows, { onConflict: "mint" });
    if (error) errors.push({ source: "update_tokens", message: error.message });
  }
  if (signals.length) {
    const { error } = await db.from("signals").insert(signals);
    if (error) errors.push({ source: "insert_signals", message: error.message });
  }
}

Deno.serve(async () => {
  const started = Date.now();
  const errors: Err[] = [];
  const tally = { saved: 0 };
  let seen = 0;
  let discovered = 0;

  try {
    discovered = await discover(errors);

    const { data: rules, error: rulesErr } = await db.from("rules").select("*").eq("id", 1).single();
    if (rulesErr || !rules) throw new Error(`rules: ${rulesErr?.message ?? "sin fila"}`);

    const { data: due, error: dueErr } = await db.from("tokens").select("*")
      .neq("status", "dead").lte("next_snapshot_at", new Date().toISOString())
      .order("next_snapshot_at").limit(MAX_DUE);
    if (dueErr) throw new Error(`due: ${dueErr.message}`);

    seen = due?.length ?? 0;
    const batches: Json[][] = [];
    for (let i = 0; i < seen; i += BATCH_SIZE) batches.push(due!.slice(i, i + BATCH_SIZE));

    // pool simple: CONCURRENCY lotes a la vez, sin iniciar otros si se agotó el tiempo
    const queue = [...batches];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length && Date.now() - started < TIME_BUDGET_MS) {
        await processBatch(queue.shift()!, rules as Rules, tally, errors);
      }
    }));
  } catch (e) {
    errors.push({ source: "collector", message: msg(e) });
  }

  const duration = Date.now() - started;
  const { error: runErr } = await db.from("collector_runs").insert({
    tokens_seen: seen, snapshots_saved: tally.saved, errors: errors.length,
    error_detail: errors.length ? errors : null, duration_ms: duration,
  });
  if (runErr) console.error("collector_runs:", runErr.message);

  return Response.json({ discovered, seen, saved: tally.saved, errors, duration_ms: duration });
});
