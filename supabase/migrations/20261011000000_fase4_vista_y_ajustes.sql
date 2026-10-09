-- Fase 4: etiqueta 'locker', umbral de LP en rules y vista token_feed para el dashboard.

-- 1) Los contratos de bloqueo/stake (LOCKER de RugCheck) se etiquetan aparte y se excluyen de las métricas
alter table memes.holder_snapshots drop constraint if exists holder_snapshots_label_check;
alter table memes.holder_snapshots add constraint holder_snapshots_label_check
  check (label in ('lp','burn','creator','exchange','locker','unknown'));

-- 2) Umbral de LP bloqueada editable (antes era una constante en la función risk)
alter table memes.rules add column if not exists lp_locked_min_pct numeric not null default 50;

-- 3) Vista del feed: último snapshot + último chequeo verificado por token (no muertos).
--    security_invoker = la RLS de las tablas base sigue aplicando al lector.
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
  la.status as risk_last_status
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
