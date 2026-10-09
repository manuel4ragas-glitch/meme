import { Suspense } from "react";
import AutoRefresh from "@/components/AutoRefresh";
import FeedClient from "@/components/FeedClient";
import { getFeed, getRules } from "@/lib/data";
import { parseFeedQuery } from "@/lib/feedQuery";

async function Feed({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  let data;
  try {
    const rules = await getRules();
    const query = parseFeedQuery(sp, rules);
    data = { rules, query, feed: await getFeed(query) };
  } catch (e) {
    return <p className="font-mono text-sm text-red-400">No se pudo leer Supabase: {e instanceof Error ? e.message : String(e)}</p>;
  }
  return <FeedClient rows={data.feed.rows} total={data.feed.total} query={data.query} rules={data.rules} />;
}

export default function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <main className="mx-auto max-w-7xl px-3 py-3">
      <Suspense fallback={<p className="font-mono text-sm text-zinc-500">Cargando feed…</p>}>
        <Feed searchParams={searchParams} />
      </Suspense>
      <AutoRefresh seconds={30} />
    </main>
  );
}
