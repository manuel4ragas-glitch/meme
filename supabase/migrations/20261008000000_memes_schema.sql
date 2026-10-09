-- Esquema aislado "memes". Se puede ejecutar más de una vez sin romper nada.
create schema if not exists memes;

-- tokens: una fila por token seguido
create table if not exists memes.tokens (
  mint             text primary key,
  symbol           text,
  name             text,
  pair_address     text,
  dex              text,
  creator          text,
  pair_created_at  timestamptz,
  first_seen_at    timestamptz not null default now(),
  source           text not null,
  status           text not null default 'tracking'
                   check (status in ('tracking','candidate','alert','discarded','dead')),
  next_snapshot_at timestamptz not null default now()
);

-- market_snapshots: nunca se sobrescribe, cada observación es una fila nueva
create table if not exists memes.market_snapshots (
  mint             text not null references memes.tokens(mint) on delete cascade,
  ts               timestamptz not null default now(),
  price_usd        numeric,
  mcap             numeric,
  fdv              numeric,
  liquidity_usd    numeric,            -- nullable: los pares pumpfun no la traen
  volume_m5        numeric, volume_h1 numeric, volume_h6 numeric, volume_h24 numeric,
  buys_m5          int, buys_h1 int, buys_h6 int, buys_h24 int,
  sells_m5         int, sells_h1 int, sells_h6 int, sells_h24 int,
  price_change_m5  numeric,
  price_change_h1  numeric,
  primary key (mint, ts)
);

-- risk_checks: un chequeo de RugCheck por fila
create table if not exists memes.risk_checks (
  mint                    text not null references memes.tokens(mint) on delete cascade,
  ts                      timestamptz not null default now(),
  score                   int,
  score_normalised        int,
  rugged                  boolean,
  mint_authority_active   boolean,
  freeze_authority_active boolean,
  lp_locked_pct           numeric,
  total_holders           int,
  top1_pct                numeric,     -- excluye wallets lp y burn
  top10_pct               numeric,     -- excluye wallets lp y burn
  insiders_count          int,
  insiders_pct            numeric,     -- excluye wallets lp y burn
  insider_evidence        text check (insider_evidence in ('none','weak','strong')),
  risks                   jsonb not null default '[]'::jsonb,
  status                  text not null default 'ok' check (status in ('ok','unverified')),
  primary key (mint, ts)
);

-- holder_snapshots: top 20 por chequeo
create table if not exists memes.holder_snapshots (
  mint        text not null references memes.tokens(mint) on delete cascade,
  ts          timestamptz not null,
  rank        int not null,
  owner       text,
  pct         numeric,
  is_insider  boolean not null default false,
  label       text not null default 'unknown'
              check (label in ('lp','burn','creator','exchange','unknown')),
  primary key (mint, ts, rank)
);

-- rules: una sola fila con mis umbrales
create table if not exists memes.rules (
  id                  int primary key default 1 check (id = 1),
  mcap_min            numeric not null default 20000,
  mcap_max            numeric not null default 300000,
  liq_min             numeric not null default 5000,
  liq_mcap_ratio_min  numeric not null default 0.05,
  max_age_min         int     not null default 360,
  top10_max_pct       numeric not null default 40,
  insiders_max_pct    numeric not null default 20,
  buy_ratio_min       numeric not null default 0.5,
  dead_liq_min        numeric not null default 1000,  -- bajo esto el token pasa a 'dead'
  updated_at          timestamptz not null default now()
);
insert into memes.rules (id) values (1) on conflict (id) do nothing;

-- signals: cada cambio de veredicto, con los datos disponibles en ese momento
create table if not exists memes.signals (
  id       bigint generated always as identity primary key,
  mint     text not null references memes.tokens(mint) on delete cascade,
  ts       timestamptz not null default now(),
  verdict  text not null,
  reasons  jsonb not null default '[]'::jsonb,
  data     jsonb not null default '{}'::jsonb
);

-- collector_runs: una fila por ejecución del recolector
create table if not exists memes.collector_runs (
  id               bigint generated always as identity primary key,
  ts               timestamptz not null default now(),
  tokens_seen      int not null default 0,
  snapshots_saved  int not null default 0,
  errors           int not null default 0,
  error_detail     jsonb,
  duration_ms      int
);

-- índices
create index if not exists idx_snap_mint_ts    on memes.market_snapshots (mint, ts desc);
create index if not exists idx_risk_mint_ts    on memes.risk_checks (mint, ts desc);
create index if not exists idx_hold_mint_ts    on memes.holder_snapshots (mint, ts desc);
create index if not exists idx_signals_mint_ts on memes.signals (mint, ts desc);
create index if not exists idx_tokens_status   on memes.tokens (status);
create index if not exists idx_tokens_next     on memes.tokens (next_snapshot_at) where status in ('tracking','candidate','alert');
create index if not exists idx_runs_ts         on memes.collector_runs (ts desc);

-- RLS: lectura pública; escritura solo service_role (que la salta); rules solo usuarios autenticados
alter table memes.tokens            enable row level security;
alter table memes.market_snapshots  enable row level security;
alter table memes.risk_checks       enable row level security;
alter table memes.holder_snapshots  enable row level security;
alter table memes.rules             enable row level security;
alter table memes.signals           enable row level security;
alter table memes.collector_runs    enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tokens','market_snapshots','risk_checks','holder_snapshots','rules','signals','collector_runs'] loop
    execute format('drop policy if exists "public read" on memes.%I', t);
    execute format('create policy "public read" on memes.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists "auth update rules" on memes.rules;
create policy "auth update rules" on memes.rules for update to authenticated using (true) with check (true);

-- permisos de tabla (las políticas RLS filtran encima de esto)
grant usage on schema memes to anon, authenticated, service_role;
grant select on all tables in schema memes to anon, authenticated;
grant update on memes.rules to authenticated;
grant all on all tables in schema memes to service_role;
grant usage, select on all sequences in schema memes to service_role;
alter default privileges in schema memes grant select on tables to anon, authenticated;
alter default privileges in schema memes grant all on tables to service_role;
alter default privileges in schema memes grant usage, select on sequences to service_role;
