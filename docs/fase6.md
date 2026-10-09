# Fase A (docs/fase6.md) — Arreglos previos

Migración: `supabase/migrations/20261013000000_fase_a_arreglos.sql` (se puede ejecutar más de una vez). Funciones redesplegadas: `risk` y `collector`.

## A1. Tokens nuevos que nunca se chequeaban
**Causa:** `risk` tomaba los 40 `candidate`/`alert` más antiguos y *después* descartaba los que ya tenían 4 chequeos. Con 40 alertas completadas, los nuevos no entraban. Cuando lo corregí, **17 candidatos llevaban horas sin chequear**: el fallo ya estaba ocurriendo.

**Solución (columnas en `tokens`):** `risk_ok_count` (chequeos verificados), `risk_first_at` (primer intento) y `risk_next_at` (cuándo toca el siguiente; `NULL` = nunca chequeado). Índice parcial `idx_tokens_risk_due` sobre `candidate`/`alert` con `risk_ok_count < 4`. La consulta de `risk` filtra por esas columnas **antes** del `LIMIT` y ordena por `risk_next_at` (los nunca chequeados primero, luego el que más espera). La función avanza el calendario (0, 5, 15, 60 min) al terminar cada chequeo. Elegí columnas y no una vista porque `risk` ya actualiza la fila del token en cada paso y así el filtro usa un índice.

**Prueba:** 50 tokens `alert` completados y muy antiguos + 1 `candidate` nuevo (datos de prueba, borrados después). El código viejo **no** incluía al nuevo en su top 40 (`false`). El nuevo se chequeó en la siguiente ejecución, ninguno de los 50 completados se tocó y no quedaron restos.

## A2. Veredictos que se pisaban
**Causa:** el collector hacía `upsert` de la fila entera (`...t`) con el `status` leído al inicio; si `risk` escribía `alert`/`discarded` en el mismo minuto, volvía a `candidate`.

**Solución:** función SQL `memes.apply_collector_updates(jsonb)`, una sola llamada por lote. Solo escribe `symbol`, `name`, `pair_address`, `dex`, `pair_created_at` y `next_snapshot_at`. El `status` cambia **solo si en la base sigue siendo el que el collector leyó** (`expect_status`); bloquea las filas con `FOR UPDATE` para ver el estado real. Devuelve `applied` por token, y la fila en `signals` se escribe únicamente cuando `applied = true`.

**Prueba (transacción revertida):** el collector leyó `candidate` y quería `tracking`, pero la base ya estaba en `alert` → `applied = false`, el estado siguió `alert`, `risk_ok_count` intacto y `symbol` sí actualizado. Caso normal (el estado coincide) → `applied = true`.

## A3. Espacio en la base
- Eliminado `idx_snap_mint_ts` (duplicaba la clave primaria): la base bajó de **81 a 66 MB**.
- `rules.retention_days` (7) y `rules.db_max_mb` (400), editables en `/rules`.
- `memes.cleanup()` (job `memes-cleanup`, diario 03:17): borra `market_snapshots` y `holder_snapshots` de tokens `dead` cuyo último snapshot supera `retention_days`, **solo si** sus `token_outcomes` y `token_age_marks` ya están `complete`; y `collector_runs` > 7 días. **No toca** `tokens`, `signals` ni `risk_checks`. `select memes.cleanup(true)` es el ensayo (cuenta sin borrar).
- Cada `collector_run` guarda `db_size_mb`; el indicador de salud muestra `base 66/400 MB` (ámbar ≥ 80 %, rojo ≥ 100 %).
- **Freno:** si la base supera `db_max_mb`, el collector deja de descubrir tokens nuevos y lo registra como error `db_size` (el dashboard muestra «descubrimiento pausado»). Con la Fase B este freno gobernará la promoción desde la cola.

### Consulta de filas y tamaño por tabla
```sql
select c.relname as tabla, s.n_live_tup as filas,
  round(pg_total_relation_size(c.oid) / 1024.0 / 1024.0, 2) as mb_total,
  round(pg_indexes_size(c.oid) / 1024.0 / 1024.0, 2) as mb_indices
from pg_stat_user_tables s join pg_class c on c.oid = s.relid
where s.schemaname = 'memes' order by pg_total_relation_size(c.oid) desc;

select memes.db_size_mb() as mb_base_total;   -- incluye el catálogo de Postgres (~10 MB)
select memes.cleanup(true);                    -- ensayo de limpieza
```

### Estimación de días hasta llenar la base (medida con 16 h de datos)
| Qué | Ritmo |
|---|---|
| `market_snapshots` + `holder_snapshots` (se pueden borrar) | ~68 MB/día |
| `tokens`, `signals`, `risk_checks`, `token_age_marks`, `token_outcomes` (**permanentes**) | ~16 MB/día |
| Catálogo de Postgres | ~10 MB fijos |

Tamaño ≈ 10 + 68 × (retención + 1) + 16 × días. El plan gratuito tiene **500 MB**; el freno salta a 400.

| `retention_days` | Se estabiliza en | El freno de 400 MB salta hacia el día |
|---|---|---|
| 7 (por defecto) | ~554 MB | **~5** (antes de que la limpieza borre nada) |
| 3 | ~282 MB + permanentes | ~18 |
| 2 | ~214 MB + permanentes | ~12–15 |
| 1 | ~146 MB + permanentes | ~16–20 |

**Conclusión:** con el ritmo actual, retener 7 días **no cabe**: el freno pararía el descubrimiento hacia el día 5. Recomiendo `retention_days = 2` hasta la Fase B, que reduce los snapshots porque solo se guardan los tokens promovidos. Además, **83 % de las filas de `signals` son veredictos `dead`** (6.940 de 8.379), que no aporta valor; es el mayor consumidor de las tablas permanentes y convendría dejar de guardarlas (no lo he hecho porque pediste no borrar `signals`).

## A4. Feed truncado
- El filtro, el orden y el límite pasan a la consulta (`getFeed` en `web/lib/data.ts`); los filtros viven en la URL (`/?status=…&mcap_min=…&sort=…&limit=…`) y el navegador solo los edita con 400 ms de retardo. Si falta un parámetro se usa el valor de `rules`; vacío = sin límite.
- Orden por defecto: `alert`, `candidate`, `discarded`, `tracking` y dentro de cada uno el más nuevo (`status_rank`, `age_min`). La vista `token_feed` ganó `status_rank` y `buy_ratio_m5`.
- Paginación con «Cargar N más» (de 100 en 100, tope 1.000) y contador «100 de 825».
- **`EXPLAIN ANALYZE` con ~5.800 tokens no muertos en la vista** (5.000 sintéticos en una transacción revertida): consulta por defecto **61 ms**; con filtro de MCap y todos los estados **97 ms**; ordenando por compras 5m **134 ms**. Crece de forma lineal (3 búsquedas indexadas por token); como los tokens pasan a `dead` a las 24 h, el tamaño de la vista está acotado.

## A5. Quién edita las reglas
- `memes.admins (user_id uuid primary key)` con RLS (cada usuario ve solo su fila). La política de `update` sobre `rules` ahora exige estar en `admins`; se eliminó `auth update rules`.
- `/rules` y «Guardar en reglas» solo se habilitan para administradores; a los demás les dice que su cuenta no lo es.

### Pasos que debe hacer el dueño del proyecto (yo no toco la configuración de seguridad)
1. **Desactivar registros nuevos:** Supabase → *Authentication* → *Sign In / Providers* → sección *User Signups* → apagar **«Allow new users to sign up»** → *Save*. (Los nombres exactos pueden variar un poco según la versión del panel.)
2. **Crear tu usuario:** *Authentication* → *Users* → *Add user* → *Create new user* con tu correo y contraseña, marcando *Auto Confirm User*. Esto sigue funcionando con los registros apagados.
3. **Hacerte administrador:** en el *SQL Editor*:
   ```sql
   insert into memes.admins (user_id)
   select id from auth.users where email = 'TU_CORREO@ejemplo.com'
   on conflict do nothing;
   ```
Hasta completar el paso 3 nadie puede editar las reglas (hoy no hay ningún usuario creado, así que no se pierde nada).
