-- Programa la función risk cada minuto. La clave reutiliza el secreto 'memes_collector_key' (service role).
-- Antes: crear el secreto de la URL (no es sensible):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/risk', 'memes_risk_url');
select cron.unschedule(jobid) from cron.job where jobname = 'memes-risk';

select cron.schedule(
  'memes-risk',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'memes_risk_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'memes_collector_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
