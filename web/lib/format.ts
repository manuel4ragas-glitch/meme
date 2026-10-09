const DASH = "—";

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return DASH;
  return `${n.toFixed(digits)}%`;
}

export function fmtSigned(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return DASH;
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function fmtAge(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return DASH;
  if (min < 60) return `${Math.max(0, Math.round(min))}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString("es-PE", {
    timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function ageMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return DASH;
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

export function buyRatio(buys: number | null, sells: number | null): number | null {
  const total = (buys ?? 0) + (sells ?? 0);
  return total > 0 ? (buys ?? 0) / total : null;
}

// volumen de los últimos 5 min frente al promedio por 5 min de la última hora
export function volumeSpike(m5: number | null, h1: number | null): number | null {
  if (m5 == null || h1 == null || h1 <= 0) return null;
  return m5 / (h1 / 12);
}
