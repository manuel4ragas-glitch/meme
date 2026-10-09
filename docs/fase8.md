# Fase C (docs/fase8.md) — Oyente de Pump.fun (PumpPortal)

Migración: `supabase/migrations/20261015000000_fase_c_oyente.sql`. Función nueva: `supabase/functions/listener/`. Muestra de eventos reales: `docs/samples/pumpportal_events.json`.

## Verificación previa (según el plan)
- **Documentación de PumpPortal** (`pumpportal.fun/data-api/real-time`): `subscribeNewToken` y `subscribeMigration` figuran como **(Free)**. `subscribeTokenTrade` y `subscribeAccountTrade` se cobran (0,01 SOL por 10.000 eventos) y **no se usan**. La página pide «una sola conexión websocket a la vez» y dice que quien abre varias puede ser bloqueado (los bloqueos caducan cada hora).
- **Prueba real** (una conexión de 40 s, sin API key): conectó en 0,56 s; llegaron 18 creaciones, 1 migración y 2 mensajes de confirmación. Campos de una creación: `signature, mint, traderPublicKey, txType, initialBuy, solAmount, bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve, marketCapSol, name, symbol, uri, is_mayhem_mode, pool`. Una migración solo trae `signature, mint, txType: "migrate", pool`.
- **Límites de las Edge Functions (plan gratuito, docs de Supabase):** 150 s de reloj, 2 s de CPU por solicitud, 256 MB. El oyente usa 48 s de escucha y no los supera. Las docs no mencionan websockets salientes; funcionan en la práctica (60 de 60 ejecuciones).

## Cómo funciona
1. **Una sola conexión** a `wss://pumpportal.fun/api/data`, suscrita únicamente a `subscribeNewToken` y `subscribeMigration`.
2. Escucha **48 s**, envía los eventos a la base por lotes cada 5 s (`memes.apply_launch_events`, una llamada por lote), cierra la conexión con código 1000 y responde a los ~50 s (pg_net espera hasta 55 s).
3. **Creaciones** → `launch_queue` sin prioridad (`pump_create`, primera revisión a los 2 min), saltando los mints que ya están en `tokens` o en la cola.
4. **Migraciones** → si el token ya está en `tokens`, se marca `migrated_at`; si no, entra a la cola con prioridad; si ya estaba en la cola, sube a prioridad; si estaba descartado, **vuelve a empezar** como detección nueva (una migración es un hecho nuevo). Probado en una transacción revertida con los cuatro casos.
5. **Sin bucles:** si la conexión falla o se corta antes de tiempo, registra el error y termina; no reintenta. Un cerrojo en `listener_runs` impide abrir una segunda conexión si hay una ejecución abierta de hace menos de 70 s.
6. **Cron** `memes-listener` cada minuto, con la URL en Vault (`memes_listener_url`) y la clave reutilizando `memes_collector_key`.
7. **Registro por ejecución** en `memes.listener_runs`: eventos recibidos, creaciones, migraciones, insertados, duplicados, segundos conectado y error. El dashboard muestra «oyente hace Nm».

## Reporte de 1 hora (22:12–23:12 UTC)
| Métrica | Resultado |
|---|---|
| Ejecuciones del oyente | **60 de 60 minutos cubiertos**, mayor intervalo 65 s, **0 errores** |
| Tiempo conectado | **47,7 s por minuto** (≈ 80 % del tiempo) |
| Eventos | 1.887 en total: **31 por minuto de media** (máximo 53) |
| Creaciones / migraciones | 1.721 (29/min) / 48 (0,8/min) |
| Encoladas / duplicadas | 1.735 / 1 |
| Collector | 59 ejecuciones, **2,65 s de media y 4,5 s máximo**, 0 errores |
| Cola | **965 → 2.223 filas**, estabilizada cerca de ~2.300 (≈ 39 entradas/min × 60 min); pesa 1,2 MB |
| Seguimiento | 187 tokens por ejecución de media (antes 300: el flujo antiguo se está vaciando) |

**Cobertura:** el oyente vio 29 creaciones/min durante el 80 % del tiempo, lo que implica unas **36–37 por minuto en total**, la cifra del plan. Entre una ejecución y la siguiente quedan ~12 s sin escuchar (el plan decía ~10 s); `rugcheck` y GeckoTerminal cubren parte de ese hueco.

**Entradas a la cola:** ~39 por minuto (listener 29 + collector 10) frente a ~24 por minuto antes de la Fase C: **+60 %**.

### Porcentaje promovido
- **Cohorte ya resuelta** (detectados 21:34–22:12, todos ya promovidos o descartados): **53 promovidos de 927 = 5,7 %** (GeckoTerminal 6,0 %, RugCheck 4,8 %, DexScreener 4 de 5).
- **`pump_create`: todavía no se puede medir.** Sus tokens llevan menos de 60 min en la cola: 1.066 de 1.135 siguen esperando (16 promovidos, 53 descartados hasta ahora). Se sabrá en ~1 h.
- **Promociones por hora: 61**, no más que las ~80 por hora de la Fase B. Es decir: **el oyente suma muchos tokens a la cola, pero casi todos son lanzamientos que nunca llegan a $20K**; no ha aumentado todavía el flujo de tokens útiles. Lo que sí aporta es detectar antes (migraciones, tokens que GeckoTerminal no lista).

### Crecimiento de la base
- 72,0 → 76,2 MB en la hora: **+4,2 MB/h** (~100 MB/día) **mientras aún se drena el flujo antiguo**. Incluye 0,8 MB del crecimiento único de la cola y espacio muerto por actualizaciones (`tokens` 1.933 filas muertas, `launch_queue` 761) que el autovacuum recupera.
- `market_snapshots` crece ~1,7 MB/h (≈ 6.000 filas/h). Con `retention_days = 2` eso se estabiliza en ~125 MB; las tablas permanentes (~16 MB/día) agotarían los 400 MB del freno en **~2 semanas**. Es una estimación: conviene remedir cuando el flujo antiguo termine de vaciarse (~24 h).

### ¿Aguanta el plan gratuito de Supabase?
| Recurso | Límite gratuito | Uso medido/proyectado |
|---|---|---|
| Invocaciones de Edge Functions | 500.000 / mes | 3 funciones × 1/min = **129.600 / mes (26 %)** |
| Duración / CPU por solicitud | 150 s / 2 s | oyente 50 s, CPU holgada (60 de 60 ejecuciones correctas) |
| Base de datos | 500 MB | 76 MB hoy; ~2 semanas hasta el freno de 400 MB con el ritmo actual |
| Egress | 5 GB / mes | no medido; lo que sale son respuestas JSON pequeñas y las lecturas del dashboard |
| Pausa por inactividad | 1 semana sin actividad | no aplica: hay actividad continua |

**Conclusión:** sí aguanta en invocaciones y límites de tiempo; el recurso que manda es el **disco de 500 MB**.

## Decisiones que conviene que revises
1. **Las creaciones de Pump.fun entran sin prioridad** (como pedía el plan), así que su primera revisión es a los 2 min; GeckoTerminal sí es prioritario y si un mint llega por los dos caminos, se queda con la fuente que entró primero.
2. **Cola ≈ 2.300 filas** en equilibrio. Si prefieres una cola más corta (menos espera), baja `queue_max_age_min` en `/rules`.
3. **Umbral de promoción:** con `queue_mcap_min = 20.000`, casi ningún lanzamiento de Pump.fun lo supera en la primera hora. Si quieres capturar más (y gastar más espacio), bájalo.
