# Fase B (docs/fase7.md) — Cola de lanzamientos y GeckoTerminal

Migración: `supabase/migrations/20261014000000_fase_b_cola.sql`. Función redesplegada: `collector`.

## Cambios previos pedidos junto a esta fase
- `rules.retention_days = 2` en la base real (el valor por defecto de la columna sigue en 7, como pedía el plan).
- El recolector **ya no escribe señales `dead`**. El estado `dead` queda en `tokens`; las ~6.900 señales `dead` que ya existían no se borraron.

## Cómo funciona
1. **`discover()` ya no inserta en `tokens`.** Todo lo descubierto entra en `memes.launch_queue` con `ON CONFLICT DO NOTHING`, saltando los mints que ya están en `tokens`.
   - Con **prioridad** (se revisan en la misma ejecución): pools nuevos de GeckoTerminal, perfiles y boosts de DexScreener.
   - **Sin prioridad** (primera revisión a los 2 min): `rugcheck /stats/new_tokens`. Las creaciones de Pump.fun llegarán en la Fase C.
2. **Revisión de la cola** (dentro del collector, sin guardar snapshots): lotes de 30 contra `tokens/v1/solana/…`, prioritarios primero. Actualiza `checks`, `last_mcap` y `next_check_at`. Calendario desde la detección: 2, 5, 10, 20, 40 y 60 min (la primera revisión inmediata de un token prioritario no gasta un hueco).
3. **Promoción** a `tokens` cuando `queue_mcap_min ≤ MCap ≤ mcap_max` **y** hubo operaciones en los últimos 5 min. Esa observación se guarda como primer snapshot y la fila sale de la cola.
4. **Descarte** (la fila pasa a `dropped`) si: supera `queue_max_age_min` (`vencido`), el MCap pasó `mcap_max` (`mcap_alto`), DexScreener no devuelve par tras 4 revisiones (`sin_par`), o el par ya es más viejo que `max_age_min` (`edad_mayor_que_max_age`, ver decisión 1).
5. **Presupuesto:** seguimiento + cola + descubrimiento ≤ 150 llamadas por minuto a DexScreener; los tokens ya promovidos van primero en la fila de trabajo. GeckoTerminal y RugCheck: 1 llamada por minuto cada uno.
6. **Freno de base:** con la base sobre `db_max_mb` no se promueve nada (la cola y el seguimiento continúan); queda como error `db_size` y el dashboard muestra «promoción pausada».
7. **`collector_runs`** gana `queued`, `promoted`, `dropped` y `queue_size`. El indicador de salud muestra `cola N (1h: +entraron ✓promovidos ✗descartados)`.
8. **Reglas nuevas** en `/rules`: `queue_mcap_min` (inicialmente igual a `mcap_min`) y `queue_max_age_min` (60).

## Decisiones que conviene que revises
1. **Descarte por edad:** un token cuyo par es más viejo que `max_age_min` (360) nunca podrá ser candidato; promoverlo solo gastaría snapshots. Es un añadido mío, no estaba en el plan.
2. **Los descartados no se borran al instante:** se quedan 24 h como `dropped` y los purga `memes.cleanup()`. Motivo: las listas de DexScreener repiten los mismos tokens muchos minutos; si se borraran de verdad, volverían a entrar y se revisarían en bucle.
3. **Liquidez desconocida:** la promoción se decide por MCap y operaciones; la liquidez de los `pumpfun` se sigue verificando con RugCheck en la función `risk` (Fase 3).

## Reporte de 30 minutos (21:34–22:04 UTC, con las fuentes actuales + GeckoTerminal)
| Métrica | Resultado |
|---|---|
| Ejecuciones | 30, **sin huecos** (el mayor intervalo fue 62 s) y **0 errores** |
| Duración del collector | **3,0 s de media, 4,4 s como máximo** (límite de trabajo propio: 45 s) |
| Entraron a la cola | **739**: GeckoTerminal 421, RugCheck 314, DexScreener 4 |
| Promovidos a seguimiento | **40** (5,4 % de lo que entró): GeckoTerminal 22 (5,2 %), RugCheck 15 (4,8 %), DexScreener 3 |
| Descartados | 31 hasta ahora: `sin_par` 30 (22 de RugCheck), `mcap_alto` 4, `edad_mayor_que_max_age` 3 (algunos por duplicado de motivo) |
| Tamaño de la cola | pasó de 63 a **675** y **todavía crece**: |
| MCap al promover | mediana **$34,3K** (mín. $20,1K, máx. $268,6K) |
| Tiempo en cola hasta promover | GeckoTerminal ~1 min; RugCheck ~3,3 min |
| Base | 70,6 → 71,8 MB (+1,2 MB en 30 min) |

**Por qué la cola sigue creciendo (no es un fallo):** entran unos 24 tokens por minuto y cada uno puede esperar hasta 60 min, así que la cola se estabilizará cerca de ~1.400 filas (menos de 1 MB). Los descartes por `vencido` apenas empiezan porque ningún token ha cumplido aún 60 min en cola. Las revisiones van al día (casi ninguna vencida).

**Porcentaje promovido:** ~5 % de lo que entra; ~95 % **ya no genera snapshots**. Antes se seguía a todo lo descubierto.

### Cuello de botella que sigue ahí (heredado del flujo anterior)
El seguimiento sigue topado en 300 tokens por ejecución porque quedan ~2.900 tokens del flujo anterior: **1.531 tienen más de 6 h y nunca podrán ser candidatos** (la regla exige edad ≤ 360 min), pero siguen consumiendo ~100 snapshots por minuto. El retraso medio es de ~1 min. Se irá vaciando solo a medida que mueran (≤ 24 h). Si quieres acelerarlo, se puede pasar a `dead` los `tracking` mayores que `max_age_min`; no lo hice porque no estaba en el plan.

### Ritmo de crecimiento de la base
Con el flujo antiguo aún drenándose, la base crece ~2,4 MB/h (58 MB/día; antes ~5 MB/h con el índice duplicado). **No se puede extrapolar todavía**: cuando se vacíen los tokens heredados el ritmo cambiará, y los tokens promovidos viven más tiempo que los antiguos (cumplen MCap y operaciones). Conviene volver a medir dentro de ~24 h.

## Consultas útiles
```sql
-- estado de la cola
select status, priority, source, count(*) from memes.launch_queue group by 1, 2, 3 order by 4 desc;
-- por qué se descartan
select drop_reason, count(*) from memes.launch_queue where status = 'dropped' group by 1 order by 2 desc;
-- evolución minuto a minuto
select ts, queued, promoted, dropped, queue_size, duration_ms from memes.collector_runs order by ts desc limit 20;
```
