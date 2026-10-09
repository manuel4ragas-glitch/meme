-- Fase 5: resultados y backtesting. Todo se calcula desde market_snapshots (nunca se modifican).

-- Tolerancia para "el snapshot más cercano": depende de la cadencia con que se sigue al token según su edad
-- (1 min < 1 h, 5 min < 6 h, 15 min después), más 1 min de holgura.
create or replace function memes.cadence_tol(age_min numeric) returns interval
language sql immutable as $$
  select case when age_min < 60 then interval '2 minutes'
              when age_min < 360 then interval '6 minutes'
              else interval '16 minutes' end
$$;

-- MCap del último snapshot en o ANTES de p_target (y dentro de la tolerancia). Nunca mira después.
create or replace function memes.mcap_at(p_mint text, p_target timestamptz, p_created timestamptz) returns numeric
language sql stable as $$
  select m.mcap from memes.market_snapshots m
  where m.mint = p_mint and m.mcap > 0
    and m.ts <= p_target
    and m.ts >= p_target - memes.cadence_tol(extract(epoch from (p_target - p_created)) / 60)
  order by m.ts desc limit 1
$$;

-- Un resultado por señal (candidate / alert / discarded)
create table if not exists memes.token_outcomes (
  signal_id          bigint primary key references memes.signals(id) on delete cascade,
  mint               text not null references memes.tokens(mint) on delete cascade,
  signal_ts          timestamptz not null,
  verdict            text not null,
  age_min_at_signal  numeric,
  age_bucket         text,
  base_mcap          numeric,          -- MCap del último snapshot ANTERIOR a la señal
  base_liquidity     numeric,
  base_buy_ratio_m5  numeric,
  ret_5m             numeric,          -- % de retorno desde la señal; NULL = aún no llega o sin dato
  ret_15m            numeric,
  ret_60m            numeric,
  ret_6h             numeric,
  ret_24h            numeric,
  carried            text[] not null default '{}',  -- horizontes rellenados con el último valor porque el token murió antes
  max_return_pct     numeric,          -- mayor MCap posterior vs. base
  min_return_pct     numeric,          -- peor MCap posterior vs. base
  max_drawdown_pct   numeric,          -- peor caída desde un máximo previo (pico a valle), en %
  token_status       text,
  last_snapshot_ts   timestamptz,
  complete           boolean not null default false,
  computed_at        timestamptz not null default now()
);
create index if not exists idx_outcomes_verdict on memes.token_outcomes (verdict, age_bucket);
create index if not exists idx_outcomes_mint on memes.token_outcomes (mint);

-- Marcas por edad desde el lanzamiento (para comparar tokens a la MISMA edad)
create table if not exists memes.token_age_marks (
  mint          text primary key references memes.tokens(mint) on delete cascade,
  created_at    timestamptz not null,
  mcap_5m       numeric, mcap_15m numeric, mcap_30m numeric, mcap_60m numeric,
  mcap_3h       numeric, mcap_6h  numeric, mcap_24h numeric,
  token_status  text,
  complete      boolean not null default false,
  computed_at   timestamptz not null default now()
);

alter table memes.token_outcomes enable row level security;
alter table memes.token_age_marks enable row level security;
drop policy if exists "public read" on memes.token_outcomes;
create policy "public read" on memes.token_outcomes for select to anon, authenticated using (true);
drop policy if exists "public read" on memes.token_age_marks;
create policy "public read" on memes.token_age_marks for select to anon, authenticated using (true);
grant select on memes.token_outcomes, memes.token_age_marks to anon, authenticated;
grant all on memes.token_outcomes, memes.token_age_marks to service_role;

create or replace function memes.refresh_outcomes() returns integer
language plpgsql as $$
declare n integer; n2 integer;
begin
  with sig as (
    select s.id, s.mint, s.ts, s.verdict, t.status as token_status,
           coalesce(t.pair_created_at, t.first_seen_at) as created
    from memes.signals s join memes.tokens t on t.mint = s.mint
    where s.verdict in ('candidate', 'alert', 'discarded')
      and not exists (select 1 from memes.token_outcomes o where o.signal_id = s.id and o.complete)
  ),
  base as (
    select sig.*, b.ts as base_ts, b.mcap as base_mcap, b.liquidity_usd as base_liq,
           case when coalesce(b.buys_m5, 0) + coalesce(b.sells_m5, 0) > 0
                then b.buys_m5::numeric / (b.buys_m5 + b.sells_m5) end as base_buy_ratio,
           l.ts as last_ts, l.mcap as last_mcap
    from sig
    left join lateral (
      select * from memes.market_snapshots m
      where m.mint = sig.mint and m.mcap > 0 and m.ts <= sig.ts
        and m.ts >= sig.ts - memes.cadence_tol(extract(epoch from (sig.ts - sig.created)) / 60)
      order by m.ts desc limit 1
    ) b on true
    left join lateral (
      select ts, mcap from memes.market_snapshots m where m.mint = sig.mint and m.mcap > 0 order by ts desc limit 1
    ) l on true
  ),
  calc as (
    select b.*,
      memes.mcap_at(b.mint, b.ts + interval '5 minutes',  b.created) as v5,
      memes.mcap_at(b.mint, b.ts + interval '15 minutes', b.created) as v15,
      memes.mcap_at(b.mint, b.ts + interval '60 minutes', b.created) as v60,
      memes.mcap_at(b.mint, b.ts + interval '6 hours',    b.created) as v360,
      memes.mcap_at(b.mint, b.ts + interval '24 hours',   b.created) as v1440
    from base b
  ),
  fin as (
    -- si el token murió antes del horizonte, se arrastra su último valor (y se marca en `carried`)
    select c.*,
      coalesce(c.v5,    case when c.token_status = 'dead' and c.last_ts < c.ts + interval '5 minutes'  then c.last_mcap end) as f5,
      coalesce(c.v15,   case when c.token_status = 'dead' and c.last_ts < c.ts + interval '15 minutes' then c.last_mcap end) as f15,
      coalesce(c.v60,   case when c.token_status = 'dead' and c.last_ts < c.ts + interval '60 minutes' then c.last_mcap end) as f60,
      coalesce(c.v360,  case when c.token_status = 'dead' and c.last_ts < c.ts + interval '6 hours'    then c.last_mcap end) as f360,
      coalesce(c.v1440, case when c.token_status = 'dead' and c.last_ts < c.ts + interval '24 hours'   then c.last_mcap end) as f1440
    from calc c
  ),
  dd as (
    select f.*, w.max_mcap, w.min_mcap, w.max_dd
    from fin f
    left join lateral (
      select max(mcap) as max_mcap, min(mcap) as min_mcap, min(mcap / run_max - 1) as max_dd
      from (
        select mcap, max(mcap) over (order by ts) as run_max
        from memes.market_snapshots m
        where m.mint = f.mint and m.mcap > 0 and m.ts >= f.base_ts and m.ts <= f.ts + interval '24 hours'
      ) q
    ) w on f.base_ts is not null
  )
  insert into memes.token_outcomes as o (
    signal_id, mint, signal_ts, verdict, age_min_at_signal, age_bucket, base_mcap, base_liquidity, base_buy_ratio_m5,
    ret_5m, ret_15m, ret_60m, ret_6h, ret_24h, carried,
    max_return_pct, min_return_pct, max_drawdown_pct, token_status, last_snapshot_ts, complete, computed_at
  )
  select d.id, d.mint, d.ts, d.verdict,
    round((extract(epoch from (d.ts - d.created)) / 60)::numeric, 1),
    case when extract(epoch from (d.ts - d.created)) / 60 < 15 then '<15m'
         when extract(epoch from (d.ts - d.created)) / 60 < 60 then '15-60m'
         when extract(epoch from (d.ts - d.created)) / 60 < 360 then '1-6h'
         else '>6h' end,
    d.base_mcap, d.base_liq, round(d.base_buy_ratio, 3),
    round((d.f5    / d.base_mcap - 1) * 100, 2), round((d.f15 / d.base_mcap - 1) * 100, 2),
    round((d.f60   / d.base_mcap - 1) * 100, 2), round((d.f360 / d.base_mcap - 1) * 100, 2),
    round((d.f1440 / d.base_mcap - 1) * 100, 2),
    array_remove(array[
      case when d.v5    is null and d.f5    is not null then '5m'  end,
      case when d.v15   is null and d.f15   is not null then '15m' end,
      case when d.v60   is null and d.f60   is not null then '60m' end,
      case when d.v360  is null and d.f360  is not null then '6h'  end,
      case when d.v1440 is null and d.f1440 is not null then '24h' end], null),
    round((d.max_mcap / d.base_mcap - 1) * 100, 2), round((d.min_mcap / d.base_mcap - 1) * 100, 2),
    round(d.max_dd * 100, 2), d.token_status, d.last_ts,
    (now() >= d.ts + interval '24 hours') or d.token_status = 'dead', now()
  from dd d
  on conflict (signal_id) do update set
    age_min_at_signal = excluded.age_min_at_signal, age_bucket = excluded.age_bucket,
    base_mcap = excluded.base_mcap, base_liquidity = excluded.base_liquidity, base_buy_ratio_m5 = excluded.base_buy_ratio_m5,
    ret_5m = excluded.ret_5m, ret_15m = excluded.ret_15m, ret_60m = excluded.ret_60m,
    ret_6h = excluded.ret_6h, ret_24h = excluded.ret_24h, carried = excluded.carried,
    max_return_pct = excluded.max_return_pct, min_return_pct = excluded.min_return_pct,
    max_drawdown_pct = excluded.max_drawdown_pct, token_status = excluded.token_status,
    last_snapshot_ts = excluded.last_snapshot_ts, complete = excluded.complete, computed_at = excluded.computed_at;
  get diagnostics n = row_count;

  -- marcas por edad desde el lanzamiento
  insert into memes.token_age_marks as a
    (mint, created_at, mcap_5m, mcap_15m, mcap_30m, mcap_60m, mcap_3h, mcap_6h, mcap_24h, token_status, complete, computed_at)
  select t.mint, c.created,
    memes.mcap_at(t.mint, c.created + interval '5 minutes',  c.created),
    memes.mcap_at(t.mint, c.created + interval '15 minutes', c.created),
    memes.mcap_at(t.mint, c.created + interval '30 minutes', c.created),
    memes.mcap_at(t.mint, c.created + interval '60 minutes', c.created),
    memes.mcap_at(t.mint, c.created + interval '3 hours',    c.created),
    memes.mcap_at(t.mint, c.created + interval '6 hours',    c.created),
    memes.mcap_at(t.mint, c.created + interval '24 hours',   c.created),
    t.status, (now() >= c.created + interval '24 hours') or t.status = 'dead', now()
  from memes.tokens t
  cross join lateral (select coalesce(t.pair_created_at, t.first_seen_at) as created) c
  where exists (select 1 from memes.market_snapshots m where m.mint = t.mint)
    and not exists (select 1 from memes.token_age_marks x where x.mint = t.mint and x.complete)
  on conflict (mint) do update set
    mcap_5m = excluded.mcap_5m, mcap_15m = excluded.mcap_15m, mcap_30m = excluded.mcap_30m, mcap_60m = excluded.mcap_60m,
    mcap_3h = excluded.mcap_3h, mcap_6h = excluded.mcap_6h, mcap_24h = excluded.mcap_24h,
    token_status = excluded.token_status, complete = excluded.complete, computed_at = excluded.computed_at;
  get diagnostics n2 = row_count;

  return n + n2;
end $$;

-- Resumen por veredicto y edad en la señal. La mediana resiste los extremos de los memecoins.
-- med_* y n_* usan solo valores OBSERVADOS (sin arrastre). med_60m_c incluye los tokens que murieron antes
-- del horizonte con su último valor: compararlos muestra cuánto pesa el sesgo de supervivencia.
create or replace view memes.outcome_summary with (security_invoker = true) as
select verdict, age_bucket,
  count(*) as n,
  count(*) filter (where complete) as n_complete,
  count(ret_5m) filter (where not '5m' = any(carried)) as n_5m,
  round((percentile_cont(0.5) within group (order by ret_5m) filter (where not '5m' = any(carried)))::numeric, 1) as med_5m,
  count(ret_15m) filter (where not '15m' = any(carried)) as n_15m,
  round((percentile_cont(0.5) within group (order by ret_15m) filter (where not '15m' = any(carried)))::numeric, 1) as med_15m,
  count(ret_60m) filter (where not '60m' = any(carried)) as n_60m,
  round((percentile_cont(0.5) within group (order by ret_60m) filter (where not '60m' = any(carried)))::numeric, 1) as med_60m,
  round((100.0 * avg((ret_60m > 0)::int) filter (where ret_60m is not null and not '60m' = any(carried)))::numeric, 0) as win_60m,
  count(ret_60m) as n_60m_c,
  round((percentile_cont(0.5) within group (order by ret_60m))::numeric, 1) as med_60m_c,
  count(ret_6h) filter (where not '6h' = any(carried)) as n_6h,
  round((percentile_cont(0.5) within group (order by ret_6h) filter (where not '6h' = any(carried)))::numeric, 1) as med_6h,
  count(ret_24h) filter (where not '24h' = any(carried)) as n_24h,
  round((percentile_cont(0.5) within group (order by ret_24h) filter (where not '24h' = any(carried)))::numeric, 1) as med_24h,
  round((percentile_cont(0.5) within group (order by max_return_pct))::numeric, 1) as med_max_return,
  round((percentile_cont(0.5) within group (order by max_drawdown_pct))::numeric, 1) as med_max_drawdown,
  count(*) filter (where cardinality(carried) > 0) as n_con_arrastre
from memes.token_outcomes
where base_mcap is not null
group by verdict, age_bucket;

-- Cohortes por edad: crecimiento del MCap respecto a la marca de 5 min. Incluye los tokens muertos;
-- n_* muestra cuántos siguen observados en cada edad (la caída de n ES el sesgo de supervivencia).
create or replace view memes.age_cohorts with (security_invoker = true) as
with m as (
  select a.*,
    case when exists (select 1 from memes.signals s where s.mint = a.mint and s.verdict = 'alert') then 'alert'
         when exists (select 1 from memes.signals s where s.mint = a.mint and s.verdict = 'discarded') then 'discarded'
         when exists (select 1 from memes.signals s where s.mint = a.mint and s.verdict = 'candidate') then 'candidate'
         else 'otros' end as cohort
  from memes.token_age_marks a where a.mcap_5m is not null
)
select cohort, count(*) as n_base,
  count(mcap_15m) as n_15m, round((percentile_cont(0.5) within group (order by mcap_15m / mcap_5m))::numeric, 2) as med_x_15m,
  count(mcap_60m) as n_60m, round((percentile_cont(0.5) within group (order by mcap_60m / mcap_5m))::numeric, 2) as med_x_60m,
  count(mcap_6h) as n_6h,  round((percentile_cont(0.5) within group (order by mcap_6h / mcap_5m))::numeric, 2) as med_x_6h,
  count(mcap_24h) as n_24h, round((percentile_cont(0.5) within group (order by mcap_24h / mcap_5m))::numeric, 2) as med_x_24h
from m group by cohort;

grant select on memes.outcome_summary, memes.age_cohorts to anon, authenticated, service_role;

-- Programación: cada 10 minutos
select cron.unschedule(jobid) from cron.job where jobname = 'memes-outcomes';
select cron.schedule('memes-outcomes', '*/10 * * * *', $$select memes.refresh_outcomes();$$);
