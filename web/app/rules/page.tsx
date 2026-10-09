import { Suspense } from "react";
import RulesForm from "@/components/RulesForm";
import { getRules } from "@/lib/data";

async function Form() {
  let rules;
  try {
    rules = await getRules();
  } catch (e) {
    return <p className="text-sm text-red-400">No se pudo leer Supabase: {e instanceof Error ? e.message : String(e)}</p>;
  }
  return <RulesForm rules={rules} />;
}

export default function RulesPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-3 py-3 font-mono">
      <h1 className="mb-1 text-base font-semibold text-zinc-100">Reglas</h1>
      <p className="mb-4 text-xs text-zinc-500">Tus umbrales. El recolector los lee en cada ejecución. Todos pueden verlos; solo un administrador puede cambiarlos.</p>
      <Suspense fallback={<p className="text-sm text-zinc-500">Cargando…</p>}><Form /></Suspense>
    </main>
  );
}
