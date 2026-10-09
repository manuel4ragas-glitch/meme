# Fase 5 — Resultados y backtesting

Migración: `supabase/migrations/20261012000000_fase5_resultados.sql`. Todo se calcula **en la base** desde `market_snapshots` (que nunca se modifica) con la función `memes.refresh_outcomes()`, programada con `pg_cron` cada 10 minutos (`memes-outcomes`). Página: `/results`.

## Qué guarda
**`token_outcomes`** — una fila por señal (`candidate`, `alert`, `discarded`):
- Contexto en la señal: edad, `age_bucket` (`<15m`, `15-60m`, `1-6h`, `>6h`), MCap, liquidez y compras 5m **del snapshot anterior a la señal**.
- Retornos `ret_5m`, `ret_15m`, `ret_60m`, `ret_6h`, `ret_24h` (% desde la señal; `NULL` = el horizonte aún no llega o no hay dato).
- `max_return_pct` (mayor MCap posterior), `min_return_pct` (peor MCap posterior) y `max_drawdown_pct` (peor caída pico a valle), hasta 24 h después.
- `carried`: horizontes rellenados porque el token murió antes (ver abajo). `complete` cuando pasaron 24 h o el token murió.

**`token_age_marks`** — MCap de cada token a los 5 min, 15 min, 30 min, 1 h, 3 h, 6 h y 24 h **desde su lanzamiento**, para comparar tokens a la misma edad.

**Vistas:** `outcome_summary` (medianas por veredicto y edad en la señal) y `age_cohorts` (crecimiento ×N respecto a la marca de 5 min por grupo).

## Cómo se evitan los sesgos
- **Sin mirar al futuro (look-ahead):** el valor base de una señal es el último snapshot **en o antes** de la señal. `mcap_at()` solo busca hacia atrás desde el instante pedido, con una tolerancia que sigue la cadencia con que se vigila el token (2 min < 1 h de vida, 6 min < 6 h, 16 min después). Los datos posteriores solo se usan para medir el resultado, nunca para decidir.
- **Sin sesgo de supervivencia:** los tokens muertos **no se excluyen**. Cuando un token murió antes de un horizonte, se arrastra su último valor y el horizonte se marca en `carried`. Ese arrastre infla artificialmente los ceros, así que el resumen:
  - calcula las **medianas solo con valores observados** (`med_*`, `n_*`), y
  - muestra aparte `med_60m_c`, que incluye los arrastres, para ver cuánto pesa el sesgo.
- **Misma edad:** `age_cohorts` compara a 15 min, 1 h, 6 h y 24 h del lanzamiento. Un token muerto deja de medirse, así que **la caída de `n` entre columnas es el sesgo de supervivencia hecho visible**.
- **Medianas, no promedios:** los memecoins tienen colas enormes; un solo ×50 arruina un promedio.

## Verificación
- 4 señales con datos se recalcularon aparte en Python con las mismas reglas: **0 discrepancias** en base, retornos, máximo, mínimo y drawdown.
- La página `/results` lee las vistas con la clave pública. Las celdas con menos de 30 observaciones salen atenuadas.

## Límites que conviene tener presentes
- **Muestras diminutas hoy:** el sistema lleva pocas horas, así que casi todos los horizontes de 6 h y 24 h están vacíos. Las cifras actuales **no son evidencia**; hace falta acumular días de datos.
- **Edad real:** si un token se descubre tarde, no hay marcas de sus primeros minutos (quedan `NULL`); el grupo `otros` es el que más datos tiene por eso.
- **Arrastre:** un token que muere pronto aporta un valor congelado, no necesariamente su valor real a ese horizonte.
- **Los cohortes son descriptivos:** «alert» se asigna con información posterior a la marca de 5 min; sirve para describir, no para predecir.
- **Esto no es una probabilidad de ganancia** ni una recomendación: el sistema solo analiza.

## Consultas útiles
```sql
select * from memes.outcome_summary order by verdict, age_bucket;
select * from memes.age_cohorts;
-- cuánto pesa el arrastre en el horizonte de 60 min
select verdict, n_60m, med_60m, n_60m_c, med_60m_c from memes.outcome_summary;
-- forzar el recálculo
select memes.refresh_outcomes();
```
