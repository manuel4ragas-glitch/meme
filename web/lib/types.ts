export type Status = "tracking" | "candidate" | "alert" | "discarded" | "dead";

export type FeedRow = {
  mint: string;
  symbol: string | null;
  name: string | null;
  dex: string | null;
  status: Status;
  age_min: number | null;
  snap_ts: string;
  price_usd: number | null;
  mcap: number | null;
  liquidity_usd: number | null;
  liq_mcap_ratio: number | null;
  volume_m5: number | null;
  volume_h1: number | null;
  buys_m5: number | null;
  sells_m5: number | null;
  buys_h1: number | null;
  sells_h1: number | null;
  price_change_m5: number | null;
  price_change_h1: number | null;
  risk_ts: string | null;
  risk_last_status: "ok" | "unverified" | null;
  score_normalised: number | null;
  top1_pct: number | null;
  top10_pct: number | null;
  insiders_pct: number | null;
  insiders_count: number | null;
  insider_evidence: "none" | "weak" | "strong" | null;
  lp_locked_pct: number | null;
};

export type Rules = {
  mcap_min: number;
  mcap_max: number;
  liq_min: number;
  liq_mcap_ratio_min: number;
  max_age_min: number;
  top10_max_pct: number;
  insiders_max_pct: number;
  buy_ratio_min: number;
  dead_liq_min: number;
  lp_locked_min_pct: number;
};

export type Snapshot = {
  ts: string;
  price_usd: number | null;
  mcap: number | null;
  liquidity_usd: number | null;
  volume_m5: number | null;
  volume_h1: number | null;
  buys_m5: number | null;
  sells_m5: number | null;
  buys_h1: number | null;
  sells_h1: number | null;
  price_change_m5: number | null;
  price_change_h1: number | null;
};

export type RiskCheck = {
  ts: string;
  score: number | null;
  score_normalised: number | null;
  rugged: boolean | null;
  mint_authority_active: boolean | null;
  freeze_authority_active: boolean | null;
  lp_locked_pct: number | null;
  total_holders: number | null;
  top1_pct: number | null;
  top10_pct: number | null;
  insiders_count: number | null;
  insiders_pct: number | null;
  insider_evidence: "none" | "weak" | "strong" | null;
  risks: { name?: string; description?: string; level?: string }[];
  status: "ok" | "unverified";
};

export type Holder = {
  ts: string;
  rank: number;
  owner: string | null;
  pct: number | null;
  is_insider: boolean;
  label: "lp" | "burn" | "creator" | "exchange" | "locker" | "unknown";
};

export type Reason = { rule: string; ok: boolean; value: number | string | boolean | null; limit?: number | string };

export type Signal = {
  id: number;
  ts: string;
  verdict: string;
  reasons: Reason[] | string[];
  data: { datos_faltantes?: string[]; [k: string]: unknown };
  mint: string;
  tokens?: { symbol: string | null; name: string | null } | null;
};

export type OutcomeSummary = {
  verdict: string; age_bucket: string; n: number; n_complete: number;
  n_5m: number; med_5m: number | null; n_15m: number; med_15m: number | null;
  n_60m: number; med_60m: number | null; win_60m: number | null; n_60m_c: number; med_60m_c: number | null;
  n_6h: number; med_6h: number | null; n_24h: number; med_24h: number | null;
  med_max_return: number | null; med_max_drawdown: number | null; n_con_arrastre: number;
};

export type AgeCohort = {
  cohort: string; n_base: number;
  n_15m: number; med_x_15m: number | null; n_60m: number; med_x_60m: number | null;
  n_6h: number; med_x_6h: number | null; n_24h: number; med_x_24h: number | null;
};
