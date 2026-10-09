# APIs verificadas (Fase 0) — 2026-10-08

Muestras reales en `docs/samples/`. Todo medido con llamadas reales, sin API key.

## DexScreener

| Endpoint | Resultado |
|---|---|
| `GET /token-profiles/latest/v1` | 200. 30 items, mezcla de cadenas (solana, bsc, ethereum…): **filtrar `chainId == "solana"`** (26/30). Campos: `chainId`, `tokenAddress`, `url`, `icon`, `header`, `description`, `links[]`. Sin precio ni mcap. |
| `GET /token-boosts/latest/v1` | 200. 30 items, también multicadena. Campos: `chainId`, `tokenAddress`, `amount`, `totalAmount`. Sin precio ni mcap. |
| `GET /tokens/v1/solana/{a,b,c}` | 200. Devuelve **pares** (puede haber varios por token, o ninguno). |

Campos de `tokens/v1` (un par): `pairAddress`, `dexId`, `baseToken{address,name,symbol}`, `quoteToken`, `priceUsd` (string), `marketCap`, `fdv`, `pairCreatedAt` (ms epoch), `txns{m5,h1,h6,h24}.{buys,sells}`, `volume{m5,h1,h6,h24}`, `priceChange{m5,h1,h6,h24}`, `info`.

**Diferencias con el plan:**
- `liquidity` **falta en los pares de `dexId: pumpfun`** (bonding curve, aún sin pool): en la muestra, 11 de 25 pares la traían y los 14 sin ella eran `pumpfun`; los `pumpswap` (ya migrados) sí. Debe ser nullable. Alternativa gratuita para los `pumpfun`: `totalMarketLiquidity` de RugCheck.
- Máximo **30 direcciones por llamada**: con 31 y 35 direcciones solo devolvió resultados de las primeras 30 (el exceso se ignora **sin error**). Hay que trocear en lotes de 30.
- 15 llamadas seguidas en 5,2 s sin 429. El límite de 300 req/min no se alcanzó; no lo forcé.
- Los endpoints de perfiles/boosts no traen fecha de creación: la edad sale de `pairCreatedAt` del par.

## RugCheck

| Endpoint | Resultado |
|---|---|
| `GET /v1/stats/new` | **404 PAGE_NOT_FOUND. No existe.** |
| `GET /v1/stats/new_tokens` | 200. Es el reemplazo. 10 items: `mint`, `symbol`, `decimals`, `creator`, `mintAuthority`, `freezeAuthority`, `program`, `createAt`, `updatedAt`. |
| `GET /v1/stats/recent` | 200. Tokens más visitados: `mint`, `metadata`, `visits`, `score`. No sirve para "nuevos". |
| `GET /v1/stats/trending`, `/verified` | `trending` devuelve `null`; `verified` es una lista curada, no sirve para descubrir. |
| `GET /v1/tokens/{mint}/report` | 200 (~9 KB). Ver campos abajo. |
| `GET /v1/tokens/{mint}/report/summary` | 200. Solo `tokenProgram`, `tokenType`, `risks`, `score`, `score_normalised`, `lpLockedPct`. Sin holders. |

**Campos del reporte** (todos los que pedía el plan existen):
- `topHolders[]`: `address`, `owner`, `pct`, `amount`, `uiAmount`, `insider` (bool). Aquí `pct` ya viene en porcentaje (34.45 = 34,45 %).
- `totalHolders` (int), `graphInsidersDetected` (int), `insiderNetworks` (puede ser `null`).
- `knownAccounts`: dict `{dirección: {name, type}}`; tipos vistos: `AMM`, `LOCKER`, `CREATOR`.
- `score`, `score_normalised`, `risks[]` (puede ser `[]`), `rugged`, `creator`, `creatorBalance`.
- `mintAuthority`, `freezeAuthority`: `null` cuando están revocadas.
- `markets[]`: `marketType`, `pubkey`, `liquidityA/B`, `lp{...}`. **`lpLockedPct` solo viene de forma directa en `/report/summary`**; en el reporte completo hay que leerlo de `markets[].lp`.
- Extras útiles: `totalMarketLiquidity`, `launchpad`, `detectedAt`, `transferFee`, `lockers`.

**Diferencias con el plan:**
- `/stats/new` → usar `/stats/new_tokens` (solo 10 tokens por llamada).
- No hay un campo `burn`; las wallets de quema habrá que detectarlas por dirección (`1nc1nerator…`, `11111…`) y las `lp` por coincidencia con `markets[].pubkey`/`knownAccounts` tipo `AMM`.
- Algunos tokens devuelven `400 {"error":"unable to generate report"}` (1 de 58). Es una respuesta normal, no un fallo de red: debe contar como `unverified`.

### Límite de RugCheck (medido)
- Secuencial: 40 peticiones en 24 s (~1,6 req/s) → todas 200, sin 429.
- Ráfaga de 58 peticiones en paralelo (20 hilos) en 2,1 s → **29 × 200, 1 × 400, 28 × 429**. Es decir, tolera una ráfaga de ~30 y luego corta.
- El 429 **no trae** cabeceras `Retry-After` ni `X-RateLimit-*`. No hay forma de saber cuánto esperar: usar backoff propio.
- Conclusión: el límite oficial sigue sin estar documentado. Mantener **≤ 1 req/s** (con margen sobre lo medido) y tratar 429 como `unverified`, con reintento tardío.

## Qué cambia en el diseño
1. Descubrimiento RugCheck: `/v1/stats/new_tokens`, no `/stats/new`.
2. Filtrar siempre por `chainId == "solana"` en perfiles y boosts.
3. Lotes de DexScreener de **máximo 30** direcciones, y comprobar que cada dirección pedida aparece en la respuesta (el exceso se pierde sin avisar).
4. Un token puede tener varios pares: elegir el de mayor liquidez y guardar su `pair_address`.
5. `liquidity` puede faltar: columna nullable y regla de mercado tolerante.
