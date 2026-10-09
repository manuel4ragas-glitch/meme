-- Fase C: oyente de Pump.fun (PumpPortal, solo subscribeNewToken y subscribeMigration). Se puede ejecutar más de una vez.

alter table memes.tokens add column if not exists migrated_at timestamptz;

-- Una fila por ejecución del oyente. También hace de cerrojo: si hay una abierta, otra ejecución no abre una
-- segunda conexión (PumpPortal bloquea a quien abre conexiones en paralelo).
create table if not exists memes.listener_runs (
  id                bigint generated always as identity primary key,
  ts                timestamptz not null default now(),
  finished_at       timestamptz,
  events_received   int not null default 0,
  creates           int not null default 0,
  migrations        int not null default 0,
  inserted          int not null default 0,
  duplicates        int not null default 0,
  seconds_connected numeric,
  error             text
);
create index if not exists idx_listener_runs_ts on memes.listener_runs (ts desc);

alter table memes.listener_runs enable row level security;
drop policy if exists "public read" on memes.listener_runs;
create policy "public read" on memes.listener_runs for select to anon, authenticated using (true);
grant select on memes.listener_runs to anon, authenticated;
grant all on memes.listener_runs to service_role;
grant usage, select on all sequences in schema memes to service_role;

-- Aplica un lote de eventos [{kind: 'create'|'migrate', mint, symbol, creator, launched_at}] en una sola llamada.
--  create  -> cola sin prioridad (si el mint ya está en tokens o en la cola, no hace nada)
--  migrate -> si el token ya se sigue, lo marca (migrated_at); si no, entra a la cola con prioridad; si ya estaba
--             en la cola sube a prioridad; si estaba descartado, vuelve a entrar (la migración es un hecho nuevo)
create or replace function memes.apply_launch_events(p jsonb) returns jsonb
language plpgsql as $$
declare v_creates int; v_inserted int; v_marked int; v_mig_new int; v_mig_up int;
begin
  select count(*) into v_creates from jsonb_to_recordset(p) as x(kind text) where kind = 'create';

  with ev as (
    select distinct on (mint) mint, symbol, creator, launched_at
    from jsonb_to_recordset(p) as x(kind text, mint text, symbol text, creator text, launched_at timestamptz)
    where kind = 'create' and mint is not null
  ), ins as (
    insert into memes.launch_queue (mint, source, symbol, creator, launched_at, priority, next_check_at)
    select e.mint, 'pump_create', e.symbol, e.creator, e.launched_at, false, now() + interval '2 minutes'
    from ev e where not exists (select 1 from memes.tokens t where t.mint = e.mint)
    on conflict (mint) do nothing
    returning 1
  ) select count(*) into v_inserted from ins;

  with mg as (
    select distinct mint from jsonb_to_recordset(p) as x(kind text, mint text) where kind = 'migrate' and mint is not null
  ), mk as (
    update memes.tokens t set migrated_at = coalesce(t.migrated_at, now()) from mg where t.mint = mg.mint returning 1
  ), q as (
    insert into memes.launch_queue as lq (mint, source, priority, next_check_at)
    select mg.mint, 'pump_migration', true, now() from mg
    where not exists (select 1 from memes.tokens t where t.mint = mg.mint)
    on conflict (mint) do update set
      priority = true,
      next_check_at = least(lq.next_check_at, now()),
      -- un descartado que migra vuelve a empezar como detección nueva
      status = 'queued',
      detected_at = case when lq.status = 'dropped' then now() else lq.detected_at end,
      checks = case when lq.status = 'dropped' then 0 else lq.checks end,
      dropped_at = null, drop_reason = null
    returning (xmax = 0) as inserted_new
  ) select (select count(*) from mk), count(*) filter (where inserted_new), count(*) filter (where not inserted_new)
    into v_marked, v_mig_new, v_mig_up from q;

  return jsonb_build_object('creates', v_creates, 'queued_creates', v_inserted,
    'duplicates', v_creates - v_inserted, 'migrations_marked', v_marked,
    'migrations_queued', v_mig_new, 'migrations_upgraded', v_mig_up);
end $$;

-- Cron cada minuto: URL y clave en Vault (la URL se crea con vault.create_secret(..., 'memes_listener_url'))
select cron.unschedule(jobid) from cron.job where jobname = 'memes-listener';
select cron.schedule('memes-listener', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'memes_listener_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'memes_collector_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
$$);

-- La limpieza diaria también borra ejecuciones del oyente de más de 7 días
create or replace function memes.cleanup(dry_run boolean default false) returns jsonb
language plpgsql as $$
declare v_snap bigint; v_hold bigint; v_runs bigint; v_queue bigint; v_listener bigint;
begin
  if dry_run then
    select count(*) into v_snap from memes.market_snapshots s join memes.cleanup_eligible e using (mint);
    select count(*) into v_hold from memes.holder_snapshots h join memes.cleanup_eligible e using (mint);
    select count(*) into v_runs from memes.collector_runs where ts < now() - interval '7 days';
    select count(*) into v_queue from memes.launch_queue where status = 'dropped' and dropped_at < now() - interval '24 hours';
    select count(*) into v_listener from memes.listener_runs where ts < now() - interval '7 days';
  else
    delete from memes.market_snapshots s using memes.cleanup_eligible e where s.mint = e.mint;
    get diagnostics v_snap = row_count;
    delete from memes.holder_snapshots h using memes.cleanup_eligible e where h.mint = e.mint;
    get diagnostics v_hold = row_count;
    delete from memes.collector_runs where ts < now() - interval '7 days';
    get diagnostics v_runs = row_count;
    delete from memes.launch_queue where status = 'dropped' and dropped_at < now() - interval '24 hours';
    get diagnostics v_queue = row_count;
    delete from memes.listener_runs where ts < now() - interval '7 days';
    get diagnostics v_listener = row_count;
  end if;
  return jsonb_build_object('dry_run', dry_run, 'market_snapshots', v_snap, 'holder_snapshots', v_hold,
                            'collector_runs', v_runs, 'launch_queue', v_queue, 'listener_runs', v_listener);
end $$;
