// Recolector: todo lo que se descubre entra a una COLA (sin snapshots); solo los tokens que cumplen las reglas
// se promueven a `tokens`, y a esos se les sigue a fondo. Lo invoca pg_cron cada minuto.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "memes" }, auth: { persistSession: false } },
);

const TIME_BUDGET_MS = 45_000; // no se inician lotes nuevos pasado este tiempo
const BATCH_SIZE = 30; // máximo de direcciones por llamada a DexScreener (medido en docs/apis.md)
const MAX_DUE = 300; // tokens seguidos por ejecución; si hay más, el resto cae en la siguiente
const MAX_DEX_CALLS = 150; // presupuesto por minuto a DexScreener: seguimiento + cola + descubrimiento
const DISCOVERY_DEX_CALLS = 2; // token-profiles y token-boosts
const CONCURRENCY = 3;
const HOUR_MS = 3_600_000;
const WSOL = "So11111111111111111111111111111111111111112";
const QUEUE_CHECK_MIN = [2, 5, 10, 20, 40, 60]; // revisiones de la cola, en minutos desde la detección
const NO_PAIR_MAX_CHECKS = 4; // sin par en DexScreener tras tantas revisiones, se descarta

type Err = { source: string; message: string };
type Counters = { saved: number; queued: number; promoted: number; dropped: number };
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

type Found = { mint: string; source: string; priority: boolean; symbol?: string; creator?: string; launched_at?: string };

// Todas las fuentes entran por la cola. priority = se revisa en la siguiente ejecución.
async function discover(errors: Err[]): Promise<number> {
  const found = new Map<string, Found>();
  const add = (f: Found) => { if (f.mint && !found.has(f.mint)) found.set(f.mint, f); };

  await Promise.all([
    (async () => {
      try {
        const list = await fetchJson("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1");
        for (const p of list?.data ?? []) {
          const base = String(p.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, "");
          const quote = String(p.relationships?.quote_token?.data?.id ?? "").replace(/^solana_/, "");
          const mint = base && base !== WSOL ? base : quote;
          const names = String(p.attributes?.name ?? "").split(" / ");
          add({ mint, source: "gecko_pool", priority: true, symbol: (base !== WSOL ? names[0] : names[1]) || undefined, launched_at: p.attributes?.pool_created_at });
        }
      } catch (e) { errors.push({ source: "gecko_pool", message: msg(e) }); }
    })(),
    (async () => {
      try {
        const list = await fetchJson("https://api.dexscreener.com/token-profiles/latest/v1");
        for (const t of list ?? []) if (t.chainId === "solana") add({ mint: t.tokenAddress, source: "dex_profile", priority: true });
      } catch (e) { errors.push({ source: "dex_profile", message: msg(e) }); }
    })(),
    (async () => {
      try {
        const list = await fetchJson("https://api.dexscreener.com/token-boosts/latest/v1");
        for (const t of list ?? []) if (t.chainId === "solana") add({ mint: t.tokenAddress, source: "dex_boost", priority: true });
      } catch (e) { errors.push({ source: "dex_boost", message: msg(e) }); }
    })(),
    (async () => {
      try {
        const list = await fetchJson("https://api.rugcheck.xyz/v1/stats/new_tokens");
        for (const t of list ?? []) add({ mint: t.mint, source: "rugcheck_new", priority: false, symbol: t.symbol, creator: t.creator || undefined, launched_at: t.createAt });
      } catch (e) { errors.push({ source: "rugcheck_new", message: msg(e) }); }
    })(),
  ]);

  if (!found.size) return 0;
  // los que ya están en `tokens` no vuelven a la cola
  const { data: have, error: haveErr } = await db.from("tokens").select("mint").in("mint", [...found.keys()]);
  if (haveErr) { errors.push({ source: "queue_filter", message: haveErr.message }); return 0; }
  const skip = new Set((have ?? []).map((r) => r.mint));

  const now = Date.now();
  const rows = [...found.values()].filter((f) => !skip.has(f.mint)).map((f) => ({
    mint: f.mint, source: f.source, symbol: f.symbol ?? null, creator: f.creator ?? null,
    launched_at: f.launched_at ?? null, priority: f.priority,
    next_check_at: new Date(now + (f.priority ? 0 : QUEUE_CHECK_MIN[0] * 60_000)).toISOString(),
  }));
  if (!rows.length) return 0;
  // ON CONFLICT DO NOTHING: lo que ya está en cola (o descartado hace poco) no se toca; select() devuelve solo lo nuevo
  const { data, error } = await db.from("launch_queue").upsert(rows, { onConflict: "mint", ignoreDuplicates: true }).select("mint");
  if (error) { errors.push({ source: "insert_queue", message: error.message }); return 0; }
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

function snapshotOf(pair: Json, mint: string, ts: string) {
  return {
    mint, ts,
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
}

type Rules = {
  mcap_min: number; mcap_max: number; liq_min: number; liq_mcap_ratio_min: number;
  max_age_min: number; buy_ratio_min: number; dead_liq_min: number; db_max_mb: number;
  queue_mcap_min: number; queue_max_age_min: number;
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

// Seguimiento de los tokens ya promovidos (guarda snapshots y aplica las reglas de mercado)
async function processBatch(batch: Json[], rules: Rules, c: Counters, errors: Err[]) {
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
  // solo las columnas del recolector + el estado esperado y el deseado (ver memes.apply_collector_updates)
  const updates: Json[] = [];
  const signalByMint = new Map<string, Json>();

  for (const t of batch) {
    const pair = pickPair(pairs ?? [], t.mint);
    if (!pair) {
      const sinceSeen = now.getTime() - new Date(t.first_seen_at).getTime();
      const dead = sinceSeen > 24 * HOUR_MS;
      updates.push({
        mint: t.mint, next_snapshot_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
        expect_status: t.status, new_status: dead ? "dead" : null,
      });
      continue;
    }

    const s = snapshotOf(pair, t.mint, nowIso);
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
      status = "dead"; // el estado queda en `tokens`; ya no se guarda una señal por cada token muerto
    } else if (t.status === "tracking" || t.status === "candidate") {
      // 'alert' y 'discarded' los decide la función de riesgo; el recolector no los degrada
      const ev = evaluate(s, ageMin, rules);
      status = ev.pass ? "candidate" : "tracking";
      if (status !== t.status) {
        signalByMint.set(t.mint, {
          mint: t.mint, ts: nowIso, verdict: status, reasons: ev.checks,
          data: { mcap: s.mcap, liquidity_usd: s.liquidity_usd, age_min: Math.round(ageMin), datos_faltantes: ev.missing },
        });
      }
    }

    updates.push({
      mint: t.mint,
      symbol: pair.baseToken?.symbol ?? null, name: pair.baseToken?.name ?? null,
      pair_address: pair.pairAddress ?? null, dex: pair.dexId ?? null, pair_created_at: createdAt.toISOString(),
      next_snapshot_at: new Date(now.getTime() + (interval ?? 1440) * 60_000).toISOString(),
      expect_status: t.status, new_status: status !== t.status ? status : null,
    });
  }

  if (snapshots.length) {
    const { error } = await db.from("market_snapshots").upsert(snapshots, { onConflict: "mint,ts", ignoreDuplicates: true });
    if (error) errors.push({ source: "insert_snapshots", message: error.message });
    else c.saved += snapshots.length;
  }
  if (updates.length) {
    const { data: results, error } = await db.rpc("apply_collector_updates", { p: updates });
    if (error) { errors.push({ source: "update_tokens", message: error.message }); return; }
    // la señal solo se escribe si el cambio de estado se aplicó de verdad (si risk cambió el estado antes, no)
    const signals = ((results ?? []) as { mint: string; applied: boolean }[])
      .filter((r) => r.applied && signalByMint.has(r.mint)).map((r) => signalByMint.get(r.mint)!);
    if (signals.length) {
      const { error: sErr } = await db.from("signals").insert(signals);
      if (sErr) errors.push({ source: "insert_signals", message: sErr.message });
    }
  }
}

// Revisión de la cola: NO guarda snapshots de los tokens en cola. Solo actualiza la fila, o la promueve / descarta.
async function reviewQueueBatch(batch: Json[], rules: Rules, canPromote: boolean, c: Counters, errors: Err[]) {
  let pairs: Json[];
  try {
    pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.map((r) => r.mint).join(",")}`);
  } catch (e) {
    errors.push({ source: "dex_queue", message: msg(e) });
    return;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const queueRows: Json[] = [];
  const tokenRows: Json[] = [];
  const snapshots: Json[] = [];
  const promotedMints: string[] = [];

  for (const row of batch) {
    const detected = new Date(row.detected_at).getTime();
    const checks = row.checks + 1;
    const pair = pickPair(pairs ?? [], row.mint);
    const mcap: number | null = pair?.marketCap ?? null;
    const drop = (reason: string) => queueRows.push({ ...row, checks, last_mcap: mcap ?? row.last_mcap, status: "dropped", dropped_at: nowIso, drop_reason: reason });
    const keep = () => {
      // la primera revisión de un token con prioridad (inmediata) no gasta un hueco del calendario 2, 5, 10, 20, 40, 60
      const idx = row.priority ? checks - 1 : checks;
      // si la próxima revisión cae pasado el máximo de espera, no tiene sentido seguir
      if (idx >= QUEUE_CHECK_MIN.length || QUEUE_CHECK_MIN[idx] > rules.queue_max_age_min) return drop("vencido");
      queueRows.push({ ...row, checks, last_mcap: mcap ?? row.last_mcap, next_check_at: new Date(detected + QUEUE_CHECK_MIN[idx] * 60_000).toISOString() });
    };

    if (!pair) { checks >= NO_PAIR_MAX_CHECKS ? drop("sin_par") : keep(); continue; }

    const pairAgeMin = pair.pairCreatedAt ? (now.getTime() - pair.pairCreatedAt) / 60_000 : null;
    const tx5 = (pair.txns?.m5?.buys ?? 0) + (pair.txns?.m5?.sells ?? 0);

    if (mcap != null && mcap > rules.mcap_max) { drop("mcap_alto"); continue; }
    // un token más viejo que max_age_min nunca podrá ser candidato: no vale la pena seguirlo
    if (pairAgeMin != null && pairAgeMin > rules.max_age_min) { drop("edad_mayor_que_max_age"); continue; }

    if (mcap != null && mcap >= rules.queue_mcap_min && tx5 > 0) {
      if (!canPromote) { keep(); continue; } // freno de base llena: se queda esperando (o vence)
      const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
      tokenRows.push({
        mint: row.mint, source: row.source, status: "tracking",
        symbol: pair.baseToken?.symbol ?? row.symbol, name: pair.baseToken?.name ?? null,
        pair_address: pair.pairAddress ?? null, dex: pair.dexId ?? null, creator: row.creator,
        pair_created_at: createdAt ? createdAt.toISOString() : null,
        first_seen_at: row.detected_at, next_snapshot_at: new Date(now.getTime() + 60_000).toISOString(),
      });
      snapshots.push(snapshotOf(pair, row.mint, nowIso)); // esta observación es el primer snapshot
      promotedMints.push(row.mint);
      continue;
    }
    keep();
  }

  if (tokenRows.length) {
    const { error } = await db.from("tokens").upsert(tokenRows, { onConflict: "mint", ignoreDuplicates: true });
    if (error) {
      errors.push({ source: "promote_tokens", message: error.message });
      // no se borran de la cola ni se guardan snapshots: se reintenta en la siguiente ejecución
      promotedMints.length = 0; snapshots.length = 0;
    } else {
      const { error: sErr } = await db.from("market_snapshots").upsert(snapshots, { onConflict: "mint,ts", ignoreDuplicates: true });
      if (sErr) errors.push({ source: "promote_snapshots", message: sErr.message });
      else c.saved += snapshots.length;
    }
  }
  if (promotedMints.length) {
    const { error } = await db.from("launch_queue").delete().in("mint", promotedMints);
    if (error) errors.push({ source: "queue_delete_promoted", message: error.message });
    else c.promoted += promotedMints.length;
  }
  if (queueRows.length) {
    const { error } = await db.from("launch_queue").upsert(queueRows, { onConflict: "mint" });
    if (error) errors.push({ source: "queue_update", message: error.message });
    else c.dropped += queueRows.filter((r) => r.status === "dropped").length;
  }
}

Deno.serve(async () => {
  const started = Date.now();
  const errors: Err[] = [];
  const c: Counters = { saved: 0, queued: 0, promoted: 0, dropped: 0 };
  let seen = 0;
  let queueSize: number | null = null;
  let dbSizeMb: number | null = null;

  try {
    const { data: rules, error: rulesErr } = await db.from("rules").select("*").eq("id", 1).single();
    if (rulesErr || !rules) throw new Error(`rules: ${rulesErr?.message ?? "sin fila"}`);

    // Freno de seguridad: con la base sobre db_max_mb no se promueven tokens (la cola y el seguimiento siguen)
    const { data: size } = await db.rpc("db_size_mb");
    dbSizeMb = size == null ? null : Number(size);
    const canPromote = !(dbSizeMb != null && dbSizeMb > rules.db_max_mb);
    if (!canPromote) errors.push({ source: "db_size", message: `base ${dbSizeMb} MB > límite ${rules.db_max_mb} MB: promoción desde la cola pausada` });

    c.queued = await discover(errors);

    // 1) seguimiento de tokens promovidos (tiene prioridad sobre la cola)
    const { data: due, error: dueErr } = await db.from("tokens").select("*")
      .neq("status", "dead").lte("next_snapshot_at", new Date().toISOString())
      .order("next_snapshot_at").limit(MAX_DUE);
    if (dueErr) throw new Error(`due: ${dueErr.message}`);
    seen = due?.length ?? 0;
    const trackedBatches: Json[][] = [];
    for (let i = 0; i < seen; i += BATCH_SIZE) trackedBatches.push(due!.slice(i, i + BATCH_SIZE));

    // 2) cola: lo que cabe en el presupuesto de llamadas que deja el seguimiento
    const queueCallBudget = Math.max(0, MAX_DEX_CALLS - DISCOVERY_DEX_CALLS - trackedBatches.length);
    const { data: dueQueue, error: qErr } = await db.from("launch_queue").select("*")
      .eq("status", "queued").lte("next_check_at", new Date().toISOString())
      .order("priority", { ascending: false }).order("next_check_at").limit(queueCallBudget * BATCH_SIZE);
    if (qErr) throw new Error(`queue: ${qErr.message}`);

    // los que llevan más de queue_max_age_min esperando se descartan sin gastar una llamada
    const expired: Json[] = [];
    const reviewable: Json[] = [];
    const nowMs = Date.now();
    for (const r of dueQueue ?? []) {
      (nowMs - new Date(r.detected_at).getTime() > rules.queue_max_age_min * 60_000 ? expired : reviewable).push(r);
    }
    if (expired.length) {
      const nowIso = new Date().toISOString();
      const { error } = await db.from("launch_queue").upsert(
        expired.map((r) => ({ ...r, status: "dropped", dropped_at: nowIso, drop_reason: "vencido" })), { onConflict: "mint" });
      if (error) errors.push({ source: "queue_expire", message: error.message });
      else c.dropped += expired.length;
    }
    const queueBatches: Json[][] = [];
    for (let i = 0; i < reviewable.length; i += BATCH_SIZE) queueBatches.push(reviewable.slice(i, i + BATCH_SIZE));

    // pool simple: CONCURRENCY lotes a la vez (primero los seguidos, luego la cola), sin empezar otros si se agotó el tiempo
    const jobs: (() => Promise<void>)[] = [
      ...trackedBatches.map((b) => () => processBatch(b, rules as Rules, c, errors)),
      ...queueBatches.map((b) => () => reviewQueueBatch(b, rules as Rules, canPromote, c, errors)),
    ];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (jobs.length && Date.now() - started < TIME_BUDGET_MS) await jobs.shift()!();
    }));

    const { count } = await db.from("launch_queue").select("mint", { count: "exact", head: true }).eq("status", "queued");
    queueSize = count ?? null;
  } catch (e) {
    errors.push({ source: "collector", message: msg(e) });
  }

  const duration = Date.now() - started;
  const { error: runErr } = await db.from("collector_runs").insert({
    tokens_seen: seen, snapshots_saved: c.saved, errors: errors.length,
    error_detail: errors.length ? errors : null, duration_ms: duration, db_size_mb: dbSizeMb,
    queued: c.queued, promoted: c.promoted, dropped: c.dropped, queue_size: queueSize,
  });
  if (runErr) console.error("collector_runs:", runErr.message);

  return Response.json({ queued: c.queued, promoted: c.promoted, dropped: c.dropped, queue_size: queueSize, seen, saved: c.saved, errors, duration_ms: duration });
});
