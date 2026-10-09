# Fase 3 — Riesgo, holders e insiders

`supabase/functions/risk/index.ts`. Cron `memes-risk` cada minuto (`supabase/migrations/20261010000000_risk_cron.sql`).

## Qué hace
1. Toma tokens en `candidate` y `alert`. (`alert` entra para poder re-chequearlo; el plan decía solo `candidate`, pero un token aprobado debe seguir vigilándose.)
2. Consulta el reporte de RugCheck: primer chequeo al entrar y de nuevo a los 5, 15 y 60 minutos (contados desde el primer intento).
3. Guarda un `risk_checks` y los 20 mayores holders en `holder_snapshots`, con etiqueta `lp`, `burn`, `creator`, `exchange` o `unknown`.
4. Aplica los descartes duros y actualiza `tokens.status`; cada cambio escribe una fila en `signals` con cada regla, su valor y su umbral.
5. Un token que no se pudo verificar guarda `status = 'unverified'` y **nunca** queda aprobado: si estaba en `alert`, vuelve a `candidate`.

## Veredictos
| Resultado | Estado del token |
|---|---|
| Alguna regla de descarte falla | `discarded` |
| Pasa los descartes, pero falla un bloqueo (liquidez no verificada o baja) | `candidate` |
| Pasa todo | `alert` |
| Sin verificar (RugCheck falló/limitó) | `candidate` |

**Descartes duros:** `rugged`, mint authority activa, freeze authority activa, LP bloqueada < `rules.lp_locked_min_pct` (50 por defecto), top 10 > `rules.top10_max_pct`, insiders > `rules.insiders_max_pct`.

**Bloqueo (no descarta):** si DexScreener no trajo liquidez (pares `pumpfun`), se verifica con `totalMarketLiquidity` de RugCheck contra `rules.liq_min`. Cierra el pendiente de la Fase 2. Se separa del descarte porque la liquidez puede crecer.

## Cómo se calculan las métricas
- **Excluidos:** wallets `lp`, `burn` y `locker` no cuentan en `top1_pct`, `top10_pct` ni `insiders_pct` (tu regla de excepción).
  - `lp`: el dueño o la cuenta es el pool (`markets[]`) o un `knownAccounts` de tipo `AMM`.
  - `burn`: `1nc1nerator…` y la dirección `1111…1111`. RugCheck no tiene un tipo para quema.
  - `creator` y `unknown` **sí** cuentan. Ejemplo real: un token con el creador al 86 % del supply se descarta por concentración.
- **`locker`**: los contratos de bloqueo/stake (`LOCKER` de RugCheck) se etiquetan aparte y también se excluyen (decisión del dueño, fase 4).
- **Insiders:** RugCheck los entrega como redes de wallets (`insiderNetworks`), no marcados en `topHolders`. `insiders_pct` es el mayor entre (suma de `currentHolding` de las redes / supply) y (suma de holders marcados). Las redes no se pueden filtrar por `lp`/`burn`.
- **Evidencia (`insider_evidence`):** `strong` si hay ≥ 3 redes, o ≥ 1 red más holders marcados; `weak` si hay alguna señal; `none` si no hay ninguna. Es una heurística mía: los insiders son señal, no prueba.
- **LP bloqueada:** se toma el mercado con más liquidez. En la bonding curve de `pump.fun` (`marketType = pump_fun`) no hay LP que bloquear: queda `NULL` y la regla no aplica.

## Límites y robustez
- RugCheck a ~1 req/s; presupuesto de 40 s por ejecución (máx. 40 tokens). Un 429 detiene la ejecución y lo deja `unverified`; un 400 «unable to generate report» también.
- El umbral de LP bloqueada vive en `rules.lp_locked_min_pct` (migración de la fase 4).
- Esta función no escribe `collector_runs`; su resultado se ve en `risk_checks`.

## Verificación
```sql
-- los chequeos recientes con su veredicto
select t.symbol, t.status, c.ts, c.top1_pct, c.top10_pct, c.insiders_pct, c.insider_evidence, c.lp_locked_pct, c.status as chequeo
from memes.risk_checks c join memes.tokens t using (mint)
order by c.ts desc limit 20;

-- distribución de holders de un token (el chequeo más reciente)
select h.rank, h.label, round(h.pct, 2) as pct, h.is_insider, left(h.owner, 8) as wallet
from memes.holder_snapshots h join memes.tokens t using (mint)
where t.symbol = 'LAYERS' and h.ts = (select max(ts) from memes.holder_snapshots where mint = h.mint)
order by h.rank;

-- por qué se descartó o aprobó
select t.symbol, s.verdict, s.ts, s.reasons from memes.signals s join memes.tokens t using (mint)
where s.verdict in ('alert','discarded') order by s.ts desc limit 10;

-- chequeos sin verificar (RugCheck falló o limitó)
select mint, ts, risks from memes.risk_checks where status = 'unverified' order by ts desc limit 10;
```
