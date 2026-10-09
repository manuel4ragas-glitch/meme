-- Fase B: cola de lanzamientos. Se puede ejecutar más de una vez.

------------------------------------------------------------------------
-- B1. launch_queue: todo lo que se descubre entra aquí; solo lo que cumple las reglas pasa a `tokens`.
-- La cola no guarda snapshots. Los descartados se conservan 24 h como "dropped" para que el mismo token,
-- que sigue apareciendo en las listas de DexScreener, no vuelva a entrar en bucle.
------------------------------------------------------------------------
create table if not exists memes.launch_queue (
  mint           text primary key,
  source         text not null,
  symbol         text,
  creator        text,
  launched_at    timestamptz,
  detected_at    timestamptz not null default now(),
  priority       boolean not null default false,
  checks         int not null default 0,
  next_check_at  timestamptz not null default now(),
  last_mcap      numeric,
  status         text not null default 'queued' check (status in ('queued', 'dropped')),
  dropped_at     timestamptz,
  drop_reason    text
);
create index if not exists idx_queue_due on memes.launch_queue (priority desc, next_check_at) where status = 'queued';
create index if not exists idx_queue_dropped on memes.launch_queue (dropped_at) where status = 'dropped';

alter table memes.launch_queue enable row level security;
drop policy if exists "public read" on memes.launch_queue;
create policy "public read" on memes.launch_queue for select to anon, authenticated using (true);
grant select on memes.launch_queue to anon, authenticated;
grant all on memes.launch_queue to service_role;

------------------------------------------------------------------------
-- B4. Reglas de la cola (editables desde /rules)
------------------------------------------------------------------------
alter table memes.rules add column if not exists queue_mcap_min numeric;
update memes.rules set queue_mcap_min = mcap_min where queue_mcap_min is null;   -- por defecto igual a mcap_min
alter table memes.rules alter column queue_mcap_min set default 20000;
alter table memes.rules alter column queue_mcap_min set not null;
alter table memes.rules add column if not exists queue_max_age_min int not null default 60;

------------------------------------------------------------------------
-- B5. Visibilidad en collector_runs
------------------------------------------------------------------------
alter table memes.collector_runs add column if not exists queued int not null default 0;
alter table memes.collector_runs add column if not exists promoted int not null default 0;
alter table memes.collector_runs add column if not exists dropped int not null default 0;
alter table memes.collector_runs add column if not exists queue_size int;

------------------------------------------------------------------------
-- La limpieza diaria también purga los descartados de la cola con más de 24 h
------------------------------------------------------------------------
create or replace function memes.cleanup(dry_run boolean default false) returns jsonb
language plpgsql as $$
declare v_snap bigint; v_hold bigint; v_runs bigint; v_queue bigint;
begin
  if dry_run then
    select count(*) into v_snap from memes.market_snapshots s join memes.cleanup_eligible e using (mint);
    select count(*) into v_hold from memes.holder_snapshots h join memes.cleanup_eligible e using (mint);
    select count(*) into v_runs from memes.collector_runs where ts < now() - interval '7 days';
    select count(*) into v_queue from memes.launch_queue where status = 'dropped' and dropped_at < now() - interval '24 hours';
  else
    delete from memes.market_snapshots s using memes.cleanup_eligible e where s.mint = e.mint;
    get diagnostics v_snap = row_count;
    delete from memes.holder_snapshots h using memes.cleanup_eligible e where h.mint = e.mint;
    get diagnostics v_hold = row_count;
    delete from memes.collector_runs where ts < now() - interval '7 days';
    get diagnostics v_runs = row_count;
    delete from memes.launch_queue where status = 'dropped' and dropped_at < now() - interval '24 hours';
    get diagnostics v_queue = row_count;
  end if;
  return jsonb_build_object('dry_run', dry_run, 'market_snapshots', v_snap, 'holder_snapshots', v_hold,
                            'collector_runs', v_runs, 'launch_queue', v_queue);
end $$;
