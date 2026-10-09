# Fase 4 — Dashboard (Vercel)

Next.js 16 (App Router, Cache Components) + Tailwind en `web/`. Lee de Supabase con la **clave publicable (anon)**; la service role no existe en el frontend. Tema oscuro, denso, sin scroll horizontal en móvil.

## Páginas
| Ruta | Qué muestra |
|---|---|
| `/` | Feed de tokens: filtros arriba (MCap mín/máx, liquidez mín, edad máx), chips por veredicto y orden. Por token: edad, MCap, liquidez, liq/MCap, momentum (barras compras vs. ventas 5m y 1h, volumen ×N, cambio de precio), top 10 %, insiders % y veredicto. Se refresca solo cada 30 s. |
| `/token/[mint]` | Ficha: gráficos de MCap y liquidez, momentum, seguridad (mint, freeze, LP bloqueada, score, riesgos), distribución de holders (barra top 1 / top 2–10 / resto, tabla con etiqueta e insider, lp/burn/locker **aparte**), insiders entre chequeos con su evidencia, y motivos del veredicto con los datos faltantes. |
| `/signals` | Historial de cambios de veredicto con las reglas evaluadas (sin tokens muertos, que eran ruido). |
| `/rules` | Los umbrales de `rules`. Todos los ven; solo un usuario autenticado los edita. |
| `/login` | Inicio de sesión (correo + contraseña) solo para editar reglas. |
| cabecera | Indicador de salud: hora del último `collector_run` y del último chequeo de riesgo (verde ≤ 3 min sin errores, ámbar ≤ 10, rojo si no). |

## Cómo funciona
- **Vista `memes.token_feed`** (migración `20261011000000_fase4_vista_y_ajustes.sql`): un token por fila con su último snapshot y su último chequeo verificado. `security_invoker`, así que la RLS de las tablas base sigue aplicando.
- **Filtros**: filtran el feed al instante en el navegador. «Guardar en reglas» escribe `mcap_min`, `mcap_max`, `liq_min` y `max_age_min` en `rules` y exige sesión (RLS: solo `authenticated` puede actualizar `rules`).
- **Veredictos**: `ALERTA` (aprobado), `CANDIDATO` (pasó mercado, falta aprobar), `EN REVISIÓN`, `SIN VERIFICAR`, `DESCARTADO`, `SIGUIENDO`. Un token sin verificar nunca aparece como aprobado.
- **Liquidez desconocida** (`pumpfun`): se muestra «—»; el filtro de liquidez no la excluye (igual que el recolector).

## Cambios de esta fase en otras capas
- `holder_snapshots.label` admite `locker`; los contratos de bloqueo/stake de RugCheck ya **no cuentan** en top 1, top 10 ni insiders (decisión del dueño).
- `rules.lp_locked_min_pct` (por defecto 50): umbral de LP bloqueada, ya no es una constante de `risk`.

## Despliegue
- Vercel (cuenta del socio) importa `manuel4ragas-glitch/meme`, *Root Directory* `web`. Cada push a `main` despliega.
- Variables de entorno en Vercel (nunca en el repo): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- **Para editar reglas hace falta un usuario**: Supabase → Authentication → Users → *Add user* (correo + contraseña, marcar *Auto Confirm*).

## Desarrollo local
```bash
cd web && npm install && npm run dev   # usa web/.env.local (ver web/.env.example)
```
