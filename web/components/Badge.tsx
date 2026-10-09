import { toneClass, type Tone } from "@/lib/verdict";

export default function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${toneClass[tone]}`}>
      {label}
    </span>
  );
}
