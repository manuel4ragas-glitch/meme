-- Programa el recolector cada minuto con pg_cron + pg_net.
-- La URL y la clave NO van aquí: se leen de Vault (ver docs/fase2.md, paso de secretos).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname in ('memes-collector', 'memes-cleanup');

select cron.schedule(
  'memes-collector',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'memes_collector_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'memes_collector_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Limpieza diaria (la base gratuita es pequeña): snapshots de tokens muertos con más de 30 días
-- y registros de ejecución con más de 7 días.
select cron.schedule(
  'memes-cleanup',
  '17 3 * * *',
  $$
  delete from memes.market_snapshots s
   using memes.tokens t
   where t.mint = s.mint and t.status = 'dead' and s.ts < now() - interval '30 days';
  delete from memes.collector_runs where ts < now() - interval '7 days';
  $$
);
