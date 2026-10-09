// Riesgo: para tokens candidatos consulta RugCheck, guarda holders e insiders y aplica los descartes duros.
// Lo invoca pg_cron cada minuto. RugCheck se llama a ~1 req/s (límite no documentado, medido en docs/apis.md).
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "memes" }, auth: { persistSession: false } },
);

const TIME_BUDGET_MS = 40_000;
const RUGCHECK_GAP_MS = 1_100;
const RETRY_GAP_MS = 60_000; // mínimo entre dos intentos del mismo token
const OFFSETS_MIN = [0, 5, 15, 60]; // chequeos: al entrar como candidato y a los 5, 15 y 60 min
const MAX_TOKENS = 40;
// lp, burn y locker (contratos de bloqueo/stake) no son holders reales: quedan fuera de las métricas
const EXCLUDED = new Set(["lp", "burn", "locker"]);
const BURN = new Set(["1nc1nerator11111111111111111111111111111111", "11111111111111111111111111111111"]);

// deno-lint-ignore no-explicit-any
type Json = any;
type Check = { rule: string; ok: boolean; value: number | string | boolean | null; limit?: number | string };
type Rules = { liq_min: number; top10_max_pct: number; insiders_max_pct: number; lp_locked_min_pct: number };
type Fetched = { kind: "ok"; data: Json } | { kind: "rate_limited" } | { kind: "failed"; message: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchReport(mint: string): Promise<Fetched> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
        signal: AbortSignal.timeout(12_000), headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) return { kind: "ok", data: await res.json() };
      if (res.status === 429) return { kind: "rate_limited" };
      if (res.status >= 500 && attempt === 0) { await sleep(1000); continue; }
      // un 400 "unable to generate report" es una respuesta normal de RugCheck: el token queda sin verificar
      return { kind: "failed", message: `HTTP ${res.status}` };
    } catch (e) {
      if (attempt === 0) { await sleep(1000); continue; }
      return { kind: "failed", message: msg(e) };
    }
  }
  return { kind: "failed", message: "sin respuesta" };
}

function analyze(d: Json, snapLiquidity: number | null, rules: Rules) {
  const holders: Json[] = Array.isArray(d.topHolders) ? d.topHolders : [];
  const known = d.knownAccounts ?? {};

  // Direcciones del pool: el holder cuyo dueño es el mercado es la liquidez, no una persona
  const poolKeys = new Set<string>();
  for (const m of d.markets ?? []) {
    for (const k of [m.pubkey, m.liquidityA, m.liquidityB, m.liquidityAAccount?.owner, m.liquidityBAccount?.owner]) if (k) poolKeys.add(k);
  }

  const labelOf = (h: Json): string => {
    const ids = [h.owner, h.address].filter(Boolean) as string[];
    if (ids.some((i) => BURN.has(i))) return "burn";
    if (ids.some((i) => poolKeys.has(i) || known[i]?.type === "AMM")) return "lp";
    if (ids.some((i) => i === d.creator || known[i]?.type === "CREATOR")) return "creator";
    if (ids.some((i) => ["CEX", "EXCHANGE"].includes(known[i]?.type))) return "exchange";
    if (ids.some((i) => known[i]?.type === "LOCKER")) return "locker";
    return "unknown";
  };

  const holderRows = holders.slice(0, 20).map((h, i) => ({
    rank: i + 1, owner: h.owner ?? h.address ?? null, pct: h.pct ?? null,
    is_insider: !!h.insider, label: labelOf(h),
  }));

  const counted = holderRows.filter((h) => !EXCLUDED.has(h.label)).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  const top1 = counted[0]?.pct ?? 0;
  const top10 = counted.slice(0, 10).reduce((s, h) => s + (h.pct ?? 0), 0);

  // Insiders: RugCheck los reporta como redes de wallets (insiderNetworks) y como marca por holder.
  // Se toma el mayor de los dos porcentajes. Las redes no se pueden filtrar por lp/burn: limitación conocida.
  const networks: Json[] = Array.isArray(d.insiderNetworks) ? d.insiderNetworks : [];
  const supply = Number(d.token?.supply);
  const netPct = supply > 0 ? (networks.reduce((s, n) => s + Number(n.currentHolding ?? 0), 0) / supply) * 100 : 0;
  const flagged = counted.filter((h) => h.is_insider);
  const flaggedPct = flagged.reduce((s, h) => s + (h.pct ?? 0), 0);
  const graph = Number(d.graphInsidersDetected ?? 0);
  const insidersPct = Math.max(netPct, flaggedPct);
  const insidersCount = Math.max(graph, flagged.length);
  // señal, no prueba: 'strong' exige varias redes, o una red más holders marcados en el top
  const evidence = networks.length >= 3 || (networks.length >= 1 && flagged.length > 0)
    ? "strong" : (networks.length > 0 || flagged.length > 0 || graph > 0) ? "weak" : "none";

  // LP: se toma el mercado con más liquidez. En la bonding curve de pump.fun no existe LP que bloquear.
  const withLp = (d.markets ?? []).filter((m: Json) => m.lp);
  withLp.sort((a: Json, b: Json) => ((b.lp.baseUSD ?? 0) + (b.lp.quoteUSD ?? 0)) - ((a.lp.baseUSD ?? 0) + (a.lp.quoteUSD ?? 0)));
  const mainMarket = withLp[0];
  const lpLocked: number | null = mainMarket && mainMarket.marketType !== "pump_fun" ? Number(mainMarket.lp.lpLockedPct ?? 0) : null;

  const mintActive = Boolean(d.mintAuthority);
  const freezeActive = Boolean(d.freezeAuthority);

  const discard: Check[] = [
    { rule: "rugged", ok: d.rugged !== true, value: d.rugged === true },
    { rule: "mint_authority_activa", ok: !mintActive, value: mintActive },
    { rule: "freeze_authority_activa", ok: !freezeActive, value: freezeActive },
    { rule: "top10_pct", ok: top10 <= rules.top10_max_pct, value: round(top10), limit: rules.top10_max_pct },
    { rule: "insiders_pct", ok: insidersPct <= rules.insiders_max_pct, value: round(insidersPct), limit: rules.insiders_max_pct },
  ];
  if (lpLocked != null) discard.push({ rule: "lp_bloqueada_pct", ok: lpLocked >= rules.lp_locked_min_pct, value: round(lpLocked), limit: rules.lp_locked_min_pct });

  // Solo bloquean la aprobación (no descartan): la liquidez puede crecer
  const blockers: Check[] = [];
  const missing: string[] = [];
  if (snapLiquidity == null) {
    // los pares pumpfun no traen liquidez en DexScreener: aquí se verifica con RugCheck (pendiente de la Fase 2)
    const liq = typeof d.totalMarketLiquidity === "number" ? d.totalMarketLiquidity : null;
    if (liq == null) { blockers.push({ rule: "liquidez_verificada", ok: false, value: null, limit: rules.liq_min }); missing.push("liquidez"); }
    else blockers.push({ rule: "liquidez_rugcheck_min", ok: liq >= rules.liq_min, value: round(liq), limit: rules.liq_min });
  }
  if (lpLocked == null) missing.push("lp_bloqueada (no aplica en bonding curve)");

  return {
    check: {
      score: d.score ?? null, score_normalised: d.score_normalised ?? null, rugged: d.rugged ?? null,
      mint_authority_active: mintActive, freeze_authority_active: freezeActive,
      lp_locked_pct: lpLocked, total_holders: d.totalHolders ?? null,
      top1_pct: round(top1), top10_pct: round(top10),
      insiders_count: insidersCount, insiders_pct: round(insidersPct), insider_evidence: evidence,
      risks: Array.isArray(d.risks) ? d.risks : [], status: "ok",
    },
    holderRows, discard, blockers, missing,
  };
}

function round(n: number) { return Math.round(n * 100) / 100; }

Deno.serve(async () => {
  const started = Date.now();
  const log = { due: 0, checked: 0, unverified: 0, changes: [] as string[], rate_limited: false, errors: [] as string[] };

  try {
    const { data: rules, error: rulesErr } = await db.from("rules").select("*").eq("id", 1).single();
    if (rulesErr || !rules) throw new Error(`rules: ${rulesErr?.message ?? "sin fila"}`);

    const { data: tokens, error: tErr } = await db.from("tokens").select("mint, status")
      .in("status", ["candidate", "alert"]).order("first_seen_at").limit(MAX_TOKENS);
    if (tErr) throw new Error(`tokens: ${tErr.message}`);
    if (!tokens?.length) return Response.json({ ...log, note: "sin candidatos" });
    const mints = tokens.map((t) => t.mint);

    const { data: history } = await db.from("risk_checks").select("mint, ts, status").in("mint", mints).order("ts");
    const { data: snaps } = await db.from("market_snapshots").select("mint, ts, liquidity_usd")
      .in("mint", mints).gt("ts", new Date(Date.now() - 15 * 60_000).toISOString()).order("ts", { ascending: false });

    const latestLiq = new Map<string, number | null>();
    for (const s of snaps ?? []) if (!latestLiq.has(s.mint)) latestLiq.set(s.mint, s.liquidity_usd);

    const now = Date.now();
    const due = tokens.filter((t) => {
      const rows = (history ?? []).filter((h) => h.mint === t.mint);
      const k = rows.filter((h) => h.status === "ok").length;
      if (k >= OFFSETS_MIN.length) return false;
      const lastAttempt = rows.length ? new Date(rows[rows.length - 1].ts).getTime() : 0;
      if (now - lastAttempt < RETRY_GAP_MS) return false;
      const t0 = rows.length ? new Date(rows[0].ts).getTime() : now;
      return now >= t0 + OFFSETS_MIN[k] * 60_000;
    });
    log.due = due.length;

    let first = true;
    for (const t of due) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      if (!first) await sleep(RUGCHECK_GAP_MS);
      first = false;

      const ts = new Date().toISOString();
      const res = await fetchReport(t.mint);

      if (res.kind !== "ok" || !Array.isArray(res.data?.topHolders)) {
        // sin verificar: nunca se muestra como aprobado. Un alert pierde la aprobación hasta verificar de nuevo.
        const why = res.kind === "ok" ? "reporte sin topHolders" : res.kind === "rate_limited" ? "HTTP 429" : res.message;
        await db.from("risk_checks").insert({ mint: t.mint, ts, status: "unverified", risks: [{ name: "unverified", description: why }] });
        log.unverified++;
        if (t.status === "alert") {
          await db.from("tokens").update({ status: "candidate" }).eq("mint", t.mint);
          await db.from("signals").insert({ mint: t.mint, ts, verdict: "candidate", reasons: [{ rule: "riesgo_sin_verificar", ok: false, value: why }], data: {} });
          log.changes.push(`${t.mint}: alert -> candidate (sin verificar)`);
        }
        if (res.kind === "rate_limited") { log.rate_limited = true; break; }
        continue;
      }

      const a = analyze(res.data, latestLiq.get(t.mint) ?? null, rules as Rules);
      const { error: cErr } = await db.from("risk_checks").insert({ mint: t.mint, ts, ...a.check });
      if (cErr) { log.errors.push(`risk_checks: ${cErr.message}`); continue; }
      if (a.holderRows.length) {
        const { error: hErr } = await db.from("holder_snapshots").insert(a.holderRows.map((h) => ({ mint: t.mint, ts, ...h })));
        if (hErr) log.errors.push(`holder_snapshots: ${hErr.message}`);
      }
      log.checked++;

      const failed = a.discard.filter((c) => !c.ok);
      const blocked = a.blockers.filter((c) => !c.ok);
      const status = failed.length ? "discarded" : blocked.length ? "candidate" : "alert";
      if (status !== t.status) {
        await db.from("tokens").update({ status }).eq("mint", t.mint);
        await db.from("signals").insert({
          mint: t.mint, ts, verdict: status, reasons: [...a.discard, ...a.blockers],
          data: { insider_evidence: a.check.insider_evidence, top1_pct: a.check.top1_pct, top10_pct: a.check.top10_pct, datos_faltantes: a.missing },
        });
        log.changes.push(`${t.mint}: ${t.status} -> ${status}`);
      }
    }
  } catch (e) {
    log.errors.push(msg(e));
  }

  return Response.json({ ...log, duration_ms: Date.now() - started });
});
