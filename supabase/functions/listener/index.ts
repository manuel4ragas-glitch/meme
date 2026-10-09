// Oyente de Pump.fun. Una ejecución = UNA conexión a PumpPortal durante ~48 s. Solo escucha dos canales gratuitos:
// subscribeNewToken (creaciones) y subscribeMigration (migraciones). Nunca subscribeTokenTrade / subscribeAccountTrade.
// Si la conexión falla o se corta, registra el error y termina: no reintenta ni abre conexiones paralelas.
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { db: { schema: "memes" }, auth: { persistSession: false } },
);

const WS_URL = "wss://pumpportal.fun/api/data";
const LISTEN_MS = 48_000; // pg_net espera hasta 55 s: queda margen para cerrar y registrar
const FLUSH_MS = 5_000;
const LOCK_MS = 70_000; // una ejecución abierta hace menos que esto bloquea a la siguiente

// deno-lint-ignore no-explicit-any
type Json = any;
type Ev = { kind: "create" | "migrate"; mint: string; symbol?: string; creator?: string; launched_at: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

Deno.serve(async () => {
  const started = Date.now();

  // cerrojo: PumpPortal bloquea a quien abre conexiones en paralelo
  const { data: open } = await db.from("listener_runs").select("id").is("finished_at", null)
    .gt("ts", new Date(started - LOCK_MS).toISOString()).limit(1);
  if (open?.length) return Response.json({ skipped: "ya hay una conexión abierta" });
  const { data: run, error: runErr } = await db.from("listener_runs").insert({}).select("id").single();
  if (runErr || !run) return Response.json({ error: `listener_runs: ${runErr?.message}` }, { status: 500 });

  const stats = { received: 0, creates: 0, migrations: 0, inserted: 0, duplicates: 0 };
  const errors: string[] = [];
  let buffer: Ev[] = [];
  let connectedSince = 0;
  let connectedMs = 0;

  async function flush() {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    const { data, error } = await db.rpc("apply_launch_events", { p: batch });
    if (error) { errors.push(`apply_launch_events: ${error.message}`); return; } // sin reintento: el lote se pierde
    stats.inserted += (data?.queued_creates ?? 0) + (data?.migrations_queued ?? 0);
    stats.duplicates += data?.duplicates ?? 0;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) { errors.push(`ws: ${msg(e)}`); return finish(); }

    const flusher = setInterval(() => { void flush(); }, FLUSH_MS);
    const stop = setTimeout(() => { try { ws.close(1000); } catch { /* ya cerrado */ } }, LISTEN_MS);
    // por si el evento close no llega: nunca se pasa del tiempo
    const hardStop = setTimeout(finish, LISTEN_MS + 3_000);

    ws.onopen = () => {
      connectedSince = Date.now();
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    };
    ws.onmessage = (m) => {
      stats.received++;
      let d: Json;
      try { d = JSON.parse(String(m.data)); } catch { return; }
      if (!d?.mint) return; // mensajes de confirmación de la suscripción
      if (d.txType === "create") {
        stats.creates++;
        buffer.push({ kind: "create", mint: d.mint, symbol: d.symbol, creator: d.traderPublicKey, launched_at: new Date().toISOString() });
      } else if (d.txType === "migrate") {
        stats.migrations++;
        buffer.push({ kind: "migrate", mint: d.mint, launched_at: new Date().toISOString() });
      }
    };
    ws.onerror = (e) => { errors.push(`ws error: ${(e as ErrorEvent).message ?? "desconocido"}`); };
    ws.onclose = (e) => {
      if (connectedSince) connectedMs = Date.now() - connectedSince;
      // un cierre antes de tiempo (distinto de nuestro cierre normal) es un fallo: se registra y se termina
      if (Date.now() - started < LISTEN_MS - 2_000) errors.push(`conexión cerrada antes de tiempo (código ${e.code})`);
      clearInterval(flusher); clearTimeout(stop); clearTimeout(hardStop);
      finish();
    };
  });

  await flush();

  const seconds = Math.round(connectedMs / 100) / 10;
  await db.from("listener_runs").update({
    finished_at: new Date().toISOString(), events_received: stats.received, creates: stats.creates, migrations: stats.migrations,
    inserted: stats.inserted, duplicates: stats.duplicates, seconds_connected: seconds, error: errors.length ? errors.join(" | ").slice(0, 500) : null,
  }).eq("id", run.id);

  return Response.json({ ...stats, seconds_connected: seconds, errors, duration_ms: Date.now() - started });
});
