import type { Status } from "./types";

export type Tone = "ok" | "warn" | "bad" | "muted";

// Un token sin verificar nunca se muestra como aprobado.
export function verdictOf(t: { status: Status; risk_last_status: string | null; risk_ts: string | null }): { label: string; tone: Tone } {
  if (t.risk_last_status === "unverified" && t.status !== "discarded" && t.status !== "tracking") {
    return { label: "SIN VERIFICAR", tone: "warn" };
  }
  switch (t.status) {
    case "alert": return { label: "ALERTA", tone: "ok" };
    case "candidate": return { label: t.risk_ts ? "CANDIDATO" : "EN REVISIÓN", tone: "warn" };
    case "discarded": return { label: "DESCARTADO", tone: "bad" };
    case "dead": return { label: "MUERTO", tone: "muted" };
    default: return { label: "SIGUIENDO", tone: "muted" };
  }
}

export const toneClass: Record<Tone, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  bad: "border-red-500/40 bg-red-500/10 text-red-300",
  muted: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
};
