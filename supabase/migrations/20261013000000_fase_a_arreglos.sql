-- Fase A: arreglos previos. Se puede ejecutar más de una vez.

------------------------------------------------------------------------
-- A1. Cola de chequeos de riesgo en la propia tabla tokens
-- risk_ok_count: chequeos verificados; risk_first_at: primer intento; risk_next_at: cuándo toca el siguiente
-- (NULL = nunca chequeado). La función risk filtra por estas columnas ANTES de aplicar el límite.
------------------------------------------------------------------------
alter table memes.tokens add column if not exists risk_ok_count int not null default 0;
alter table memes.tokens add column if not exists risk_first_at timestamptz;
alter table memes.tokens add column if not exists risk_next_at timestamptz;

-- reconstruye el estado desde risk_checks (calendario: 0, 5, 15 y 60 min desde el primer intento)
with c as (
  select mint, min(ts) as first_at, max(ts) as last_at, count(*) filter (where status = 'ok') as ok_n
  from memes.risk_checks group by mint
)
update memes.tokens t set
  risk_first_at = c.first_at,
  risk_ok_count = c.ok_n,
  risk_next_at = case
    when c.ok_n >= 4 then null
    when c.ok_n = 0 then c.last_at + interval '1 minute'
    else c.first_at + (array[0, 5, 15, 60])[c.ok_n + 1] * interval '1 minute' end
from c where t.mint = c.mint;

create index if not exists idx_tokens_risk_due on memes.tokens (risk_next_at nulls first, first_seen_at)
  where status in ('candidate', 'alert') and risk_ok_count < 4;

------------------------------------------------------------------------
-- A2. El collector solo escribe sus columnas y el status solo cambia si sigue siendo el que leyó
-- Una sola llamada por lote. Devuelve, por token, si el cambio de estado se aplicó (para escribir la señal).
------------------------------------------------------------------------
create or replace function memes.apply_collector_updates(p jsonb)
returns table (mint text, applied boolean)
language sql as $$
  with u as (
    select * from jsonb_to_recordset(p) as x(
      mint text, symbol text, name text, pair_address text, dex text,
      pair_created_at timestamptz, next_snapshot_at timestamptz, expect_status text, new_status text)
  ),
  old as (  -- bloquea las filas: si risk las está cambiando, espera y luego ve el estado real
    select t.mint, t.status from memes.tokens t join u on u.mint = t.mint for update of t
  ),
  upd as (
    update memes.tokens t set
      symbol = coalesce(u.symbol, t.symbol),
      name = coalesce(u.name, t.name),
      pair_address = coalesce(u.pair_address, t.pair_address),
      dex = coalesce(u.dex, t.dex),
      pair_created_at = coalesce(u.pair_created_at, t.pair_created_at),
      next_snapshot_at = u.next_snapshot_at,
      status = case when u.new_status is not null and o.status = u.expect_status then u.new_status else t.status end
    from u join old o on o.mint = u.mint
    where t.mint = u.mint
    returning t.mint, (u.new_status is not null and o.status = u.expect_status) as applied
  )
  select upd.mint, upd.applied from upd
$$;

------------------------------------------------------------------------
-- A3. Espacio en la base
------------------------------------------------------------------------
drop index if exists memes.idx_snap_mint_ts;  -- duplicaba la clave primaria (mint, ts)

alter table memes.rules add column if not exists retention_days int not null default 7;
alter table memes.rules add column if not exists db_max_mb int not null default 400;
alter table memes.collector_runs add column if not exists db_size_mb numeric;

create or replace function memes.db_size_mb() returns numeric
language sql stable as $$ select round(pg_database_size(current_database()) / 1024.0 / 1024.0, 1) $$;

-- Tokens muertos cuyos datos pesados ya se pueden borrar: último snapshot más viejo que retention_days y
-- backtesting (outcomes + marcas por edad) ya cerrado, para no perder los resultados de la Fase 5.
create or replace view memes.cleanup_eligible as
select t.mint
from memes.tokens t
where t.status = 'dead'
  and not exists (
    select 1 from memes.market_snapshots s
    where s.mint = t.mint and s.ts >= now() - make_interval(days => (select retention_days from memes.rules where id = 1)))
  and exists (select 1 from memes.token_age_marks a where a.mint = t.mint and a.complete)
  and not exists (select 1 from memes.token_outcomes o where o.mint = t.mint and not o.complete);

-- Borra snapshots (mercado y holders) de esos tokens y collector_runs viejos.
-- NO toca tokens, signals ni risk_checks: token_outcomes cuelga de signals con on delete cascade.
create or replace function memes.cleanup(dry_run boolean default false) returns jsonb
language plpgsql as $$
declare v_snap bigint; v_hold bigint; v_runs bigint;
begin
  if dry_run then
    select count(*) into v_snap from memes.market_snapshots s join memes.cleanup_eligible e using (mint);
    select count(*) into v_hold from memes.holder_snapshots h join memes.cleanup_eligible e using (mint);
    select count(*) into v_runs from memes.collector_runs where ts < now() - interval '7 days';
  else
    delete from memes.market_snapshots s using memes.cleanup_eligible e where s.mint = e.mint;
    get diagnostics v_snap = row_count;
    delete from memes.holder_snapshots h using memes.cleanup_eligible e where h.mint = e.mint;
    get diagnostics v_hold = row_count;
    delete from memes.collector_runs where ts < now() - interval '7 days';
    get diagnostics v_runs = row_count;
  end if;
  return jsonb_build_object('dry_run', dry_run, 'market_snapshots', v_snap, 'holder_snapshots', v_hold, 'collector_runs', v_runs);
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'memes-cleanup';
select cron.schedule('memes-cleanup', '17 3 * * *', $$select memes.cleanup();$$);

------------------------------------------------------------------------
-- A4. La vista del feed gana columnas para ordenar y filtrar en el servidor (se añaden al final)
------------------------------------------------------------------------
create or replace view memes.token_feed with (security_invoker = true) as
select
  t.mint, t.symbol, t.name, t.dex, t.status, t.pair_created_at, t.first_seen_at,
  extract(epoch from (now() - coalesce(t.pair_created_at, t.first_seen_at))) / 60 as age_min,
  s.ts as snap_ts, s.price_usd, s.mcap, s.liquidity_usd,
  case when s.mcap > 0 and s.liquidity_usd is not null then s.liquidity_usd / s.mcap end as liq_mcap_ratio,
  s.volume_m5, s.volume_h1, s.buys_m5, s.sells_m5, s.buys_h1, s.sells_h1,
  s.price_change_m5, s.price_change_h1,
  r.ts as risk_ts, r.score_normalised, r.top1_pct, r.top10_pct,
  r.insiders_pct, r.insiders_count, r.insider_evidence, r.lp_locked_pct,
  r.rugged, r.mint_authority_active, r.freeze_authority_active,
  la.status as risk_last_status,
  case t.status when 'alert' then 0 when 'candidate' then 1 when 'discarded' then 2 else 3 end as status_rank,
  case when coalesce(s.buys_m5, 0) + coalesce(s.sells_m5, 0) > 0
       then s.buys_m5::numeric / (s.buys_m5 + s.sells_m5) end as buy_ratio_m5
from memes.tokens t
left join lateral (
  select * from memes.market_snapshots where mint = t.mint order by ts desc limit 1
) s on true
left join lateral (
  select * from memes.risk_checks where mint = t.mint and status = 'ok' order by ts desc limit 1
) r on true
left join lateral (
  select status from memes.risk_checks where mint = t.mint order by ts desc limit 1
) la on true
where t.status <> 'dead' and s.ts is not null;

grant select on memes.token_feed to anon, authenticated, service_role;

------------------------------------------------------------------------
-- A5. Solo los administradores editan las reglas
------------------------------------------------------------------------
create table if not exists memes.admins (user_id uuid primary key);
alter table memes.admins enable row level security;
drop policy if exists "own admin row" on memes.admins;
create policy "own admin row" on memes.admins for select to authenticated using (user_id = auth.uid());
grant select on memes.admins to authenticated;
grant all on memes.admins to service_role;

drop policy if exists "auth update rules" on memes.rules;
drop policy if exists "admin update rules" on memes.rules;
create policy "admin update rules" on memes.rules for update to authenticated
  using (exists (select 1 from memes.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from memes.admins a where a.user_id = auth.uid()));
