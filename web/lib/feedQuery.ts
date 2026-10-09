import type { Rules, Status } from "./types";

export const SORTS = ["status", "age", "mcap", "momentum"] as const;
export type Sort = (typeof SORTS)[number];

export const FEED_STATUSES: Status[] = ["alert", "candidate", "discarded", "tracking"];
export const PAGE_SIZE = 100;
export const MAX_LIMIT = 1000;

export type FeedQuery = {
  statuses: Status[];
  mcapMin: number | null;
  mcapMax: number | null;
  liqMin: number | null;
  maxAge: number | null;
  sort: Sort;
  limit: number;
};

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function num(v: string | undefined, fallback: number | null): number | null {
  if (v === undefined) return fallback; // sin parámetro: se usa el valor de rules
  if (v.trim() === "") return null; // parámetro vacío: sin límite
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Los filtros viven en la URL: el servidor filtra y ordena en la consulta, no en el navegador.
export function parseFeedQuery(sp: Params, rules: Rules): FeedQuery {
  const rawStatus = first(sp.status);
  const statuses = rawStatus === undefined
    ? (["alert", "candidate", "discarded"] as Status[])
    : (rawStatus.split(",").filter((s): s is Status => (FEED_STATUSES as string[]).includes(s)));
  const sort = SORTS.find((s) => s === first(sp.sort)) ?? "status";
  const limit = Math.min(MAX_LIMIT, Math.max(25, Number(first(sp.limit)) || PAGE_SIZE));
  return {
    statuses,
    mcapMin: num(first(sp.mcap_min), rules.mcap_min),
    mcapMax: num(first(sp.mcap_max), rules.mcap_max),
    liqMin: num(first(sp.liq_min), rules.liq_min),
    maxAge: num(first(sp.max_age), rules.max_age_min),
    sort,
    limit,
  };
}

export function toSearch(q: FeedQuery): string {
  const p = new URLSearchParams();
  p.set("status", q.statuses.join(","));
  p.set("mcap_min", q.mcapMin == null ? "" : String(q.mcapMin));
  p.set("mcap_max", q.mcapMax == null ? "" : String(q.mcapMax));
  p.set("liq_min", q.liqMin == null ? "" : String(q.liqMin));
  p.set("max_age", q.maxAge == null ? "" : String(q.maxAge));
  p.set("sort", q.sort);
  p.set("limit", String(q.limit));
  return p.toString();
}
