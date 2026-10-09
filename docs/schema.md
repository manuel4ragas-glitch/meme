# Esquema `memes`

Todo vive en el esquema `memes`; no se toca `public`. Hora en UTC (`timestamptz`). Migración: `supabase/migrations/20261008000000_memes_schema.sql`.

| Tabla | Para qué | Clave |
|---|---|---|
| `tokens` | Un token seguido y su estado (`tracking`/`candidate`/`alert`/`discarded`/`dead`). `next_snapshot_at` dice cuándo toca volver a consultarlo. | `mint` |
| `market_snapshots` | Mercado cada minuto (precio, mcap, liquidez, volumen, compras/ventas). Solo se insertan filas, nunca se actualizan. | `(mint, ts)` |
| `risk_checks` | Chequeo de RugCheck: score, autoridades, LP bloqueada, top 1/top 10/insiders y su nivel de evidencia. | `(mint, ts)` |
| `holder_snapshots` | Top 20 holders de cada chequeo, con etiqueta e insider. | `(mint, ts, rank)` |
| `rules` | Una sola fila (`id = 1`) con tus umbrales. | `id` |
| `signals` | Cada cambio de veredicto con sus motivos. | `id` |
| `collector_runs` | Una fila por ejecución del recolector (salud del sistema). | `id` |

## Decisiones
- **`liquidity_usd` acepta NULL**: DexScreener no la devuelve para pares `pumpfun` (ver `docs/apis.md`).
- **`mint_authority_active` / `freeze_authority_active`** son booleanos: RugCheck devuelve `null` si la autoridad fue revocada.
- **`insider_evidence`** (`none`/`weak`/`strong`): los insiders son una señal, no una prueba.
- **`top1_pct`, `top10_pct`, `insiders_pct`** se calculan en la función `risk` excluyendo wallets `lp` y `burn`. La base solo guarda el resultado.
- **`holder_snapshots.label`** admite también `locker` (contratos de bloqueo/stake; se excluyen de las métricas como `lp` y `burn`).
- **`rules.lp_locked_min_pct`** (extra al plan, por defecto 50): LP bloqueada mínima para no descartar.
- **Vista `token_feed`**: último snapshot y último chequeo verificado por token no muerto; la usa el dashboard (`docs/fase4.md`).
- **Fase 5:** `token_outcomes` (resultado por señal) y `token_age_marks` (MCap por edad desde el lanzamiento), con las vistas `outcome_summary` y `age_cohorts`. Detalle en `docs/fase5.md`.
- **`rules.dead_liq_min`** (extra al plan): liquidez bajo la cual un token pasa a `dead`. Los valores por defecto de `rules` son una propuesta; ajústalos a tu criterio.
- **RLS**: cualquiera puede leer; solo `service_role` escribe (las Edge Functions); solo un usuario autenticado puede editar `rules`. Ojo para la Fase 4: guardar filtros desde el dashboard exigirá iniciar sesión.

## Pasos manuales (los hace el dueño del proyecto)
1. En **SQL Editor**, pegar y ejecutar el archivo de migración completo.
2. En **Project Settings → API → Exposed schemas**, añadir `memes` (si no, el cliente no puede leerlo) y guardar.

## Verificación
```sql
select table_name from information_schema.tables where table_schema = 'memes' order by 1;  -- 7 tablas
select * from memes.rules;                                                                    -- 1 fila
select tablename, rowsecurity from pg_tables where schemaname = 'memes';                      -- todas true
```
