import { Suspense } from "react";
import AutoRefresh from "@/components/AutoRefresh";
import FeedClient from "@/components/FeedClient";
import { getFeed, getRules } from "@/lib/data";

async function Feed() {
  let data;
  try {
    data = await Promise.all([getFeed(), getRules()]);
  } catch (e) {
    return <p className="font-mono text-sm text-red-400">No se pudo leer Supabase: {e instanceof Error ? e.message : String(e)}</p>;
  }
  return <FeedClient rows={data[0]} rules={data[1]} />;
}

export default function Home() {
  return (
    <main className="mx-auto max-w-7xl px-3 py-3">
      <Suspense fallback={<p className="font-mono text-sm text-zinc-500">Cargando feed…</p>}>
        <Feed />
      </Suspense>
      <AutoRefresh seconds={30} />
    </main>
  );
}
