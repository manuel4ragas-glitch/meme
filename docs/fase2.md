# Fase 2 — Recolector

`supabase/functions/collector/index.ts` (un solo archivo, sin dependencias locales, para poder pegarlo en el dashboard).

## Qué hace en cada ejecución
1. **Descubre** tokens nuevos de Solana en `rugcheck /stats/new_tokens`, `dex token-profiles` y `dex token-boosts`. Los inserta en `tokens` con `ON CONFLICT DO NOTHING`. Cada fuente va en su propio `try`: si una falla, las otras siguen.
2. **Toma los tokens vencidos** (`next_snapshot_at <= now()`, `status != dead`), hasta 300 por ejecución, en lotes de 30 direcciones (máximo de DexScreener) y 3 lotes en paralelo.
3. **Guarda un snapshot** nuevo por token (nunca sobrescribe). Si el token tiene varios pares, elige el de mayor liquidez.
4. **Programa el próximo snapshot** según la edad del par: cada 1 min < 1 h, cada 5 min < 6 h, cada 15 min < 24 h; después `dead`.
5. **Marca `dead`** antes si: liquidez < `rules.dead_liq_min` (solo si el dato existe), o sin transacciones en 1 h (token de al menos 60 min), o 24 h sin aparecer ningún par.
6. **Evalúa las reglas de mercado** y pasa el token entre `tracking` ⇄ `candidate`. Cada cambio escribe una fila en `signals` con cada regla, su valor y su umbral. No toca `alert` ni `discarded` (los decide `risk`, Fase 3).
7. **Registra la ejecución** en `collector_runs` (tokens vistos, snapshots, errores, duración).

## Robustez
- Timeout de 8 s por petición; hasta 2 reintentos con backoff exponencial y jitter para 429 y 5xx (un 4xx distinto de 429 no se reintenta).
- Presupuesto de 45 s: pasado ese tiempo no se inician lotes nuevos (el límite de la Edge Function es bastante mayor).
- Si falla un lote de DexScreener, esos tokens siguen vencidos y se reintentan al minuto siguiente.

## Decisiones que conviene que revises
- **Liquidez desconocida (`pumpfun`)**: no bloquea el veredicto, pero queda en `signals.data.datos_faltantes`. Eso significa que un token de bonding curve puede ser `candidate` sin que se haya comprobado su liquidez; la función `risk` (Fase 3) debe verificarla con RugCheck antes de aprobar nada.
- **Compras m5**: sin transacciones en los últimos 5 min la regla falla (no se puede medir momentum).
- **Tokens viejos**: DexScreener devuelve perfiles/boosts de tokens de más de 24 h. Se les toma un snapshot y pasan a `dead`. Si no quieres ese snapshot, se puede filtrar en el descubrimiento.
- **Sin histéresis**: un token que oscila alrededor de un umbral genera una señal en cada cruce.

## Pasos para activarlo (los hace el dueño del proyecto)
1. **Desplegar la función**: Dashboard → Edge Functions → *Deploy a new function* → nombre `collector` → pegar el contenido de `index.ts`. Dejar activada la verificación de JWT.
2. **Guardar los secretos en Vault** (SQL Editor; sustituir los valores, no se suben al repo):
   ```sql
   select vault.create_secret('https://krkmfofufltxssdbxzgq.supabase.co/functions/v1/collector', 'memes_collector_url');
   select vault.create_secret('<SERVICE_ROLE_KEY>', 'memes_collector_key');
   ```
3. **Programar el cron**: ejecutar `supabase/migrations/20261009000000_collector_cron.sql` en el SQL Editor.
4. **Prueba manual** antes de esperar al cron: Edge Functions → `collector` → *Test* (o `curl -X POST` con `Authorization: Bearer <SERVICE_ROLE_KEY>`). Debe responder JSON con `discovered`, `seen`, `saved` y `errors: []`.

## Verificación
```sql
-- snapshots de los últimos 10 minutos
select t.symbol, s.ts, s.mcap, s.liquidity_usd, s.buys_m5, s.sells_m5
from memes.market_snapshots s join memes.tokens t using (mint)
where s.ts > now() - interval '10 minutes'
order by s.ts desc limit 50;

-- ejecuciones recientes: huecos y errores
select ts, tokens_seen, snapshots_saved, errors, duration_ms, error_detail
from memes.collector_runs order by ts desc limit 20;

-- el cron está corriendo
select status, return_message, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'memes-collector')
order by start_time desc limit 10;

-- tokens por estado
select status, count(*) from memes.tokens group by 1;
```
Dejarlo correr 30 minutos y revisar: `collector_runs` debe tener ~30 filas sin huecos de más de 1 minuto y `errors = 0` (salvo fallos puntuales de una fuente).
