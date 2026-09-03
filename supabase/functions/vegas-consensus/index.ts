import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://golderr.github.io",
  "http://127.0.0.1:8765",
  "http://localhost:8765",
]);

const corsFor = (request: Request) => {
  const origin = request.headers.get("origin") || "";
  return {
    "access-control-allow-origin": allowedOrigins.has(origin) ? origin : "https://golderr.github.io",
    "access-control-allow-headers": "content-type, if-none-match",
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "public, max-age=60, stale-while-revalidate=300",
    "vary": "Origin",
  };
};

const respond = (request: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) => new Response(status === 304 ? null : JSON.stringify(body), {
  status,
  headers: { ...corsFor(request), ...extraHeaders, "content-type": "application/json; charset=utf-8" },
});

const adminClient = () => {
  let managedSecret = "";
  try { managedSecret = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch { /* legacy projects use the service-role variable */ }
  const secret = managedSecret || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("Supabase secret key is unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, secret, { auth: { persistSession: false } });
};

async function consensusRows(client: ReturnType<typeof adminClient>, season: number, player: string | null, market: string | null) {
  const output: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let page = 0; page < 6; page += 1) {
    let query = client.from("vegas_consensus_materialized_current").select("*").eq("season", season)
      .order("player_name").order("market_key").range(page * pageSize, (page + 1) * pageSize - 1);
    if (player) query = query.eq("player_key", player);
    if (market) query = query.eq("market_key", market);
    const { data, error } = await query;
    if (error) throw error;
    output.push(...(data || []));
    if (!data || data.length < pageSize) return output;
  }
  throw new Error("Consensus response exceeded the 6,000-row safety limit");
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(request) });
  if (request.method !== "GET") return respond(request, { error: "GET required" }, 405);
  try {
    const url = new URL(request.url);
    const season = Number(url.searchParams.get("season") || new Date().getUTCFullYear());
    if (!Number.isInteger(season) || season < 2000 || season > 2100) return respond(request, { error: "Invalid season" }, 400);
    const client = adminClient();
    const player = url.searchParams.get("player");
    const market = url.searchParams.get("market");
    const [data, healthResult] = await Promise.all([
      consensusRows(client, season, player, market),
      client.from("vegas_pipeline_health").select("latest_status,last_success_at,minutes_since_success,quote_count,book_count,player_count,market_count,consecutive_failures").eq("season", season).maybeSingle(),
    ]);
    if (healthResult.error) throw healthResult.error;
    const retrievedAt = data.reduce((latest, row) => !latest || String(row.retrieved_at) > latest ? String(row.retrieved_at) : latest, "") || null;
    const books = new Set(data.flatMap(row => Array.isArray(row.sportsbooks) ? row.sportsbooks : []));
    const etag = `W/\"${season}-${retrievedAt || "empty"}-${data.length}\"`;
    if (request.headers.get("if-none-match") === etag) return respond(request, null, 304, { etag });
    return respond(request, {
      data,
      meta: {
        season,
        retrievedAt,
        rowCount: data.length,
        bookCount: books.size,
        health: healthResult.data || null,
      },
    }, 200, { etag });
  } catch (error) {
    const detail = error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error);
    return respond(request, { error: detail }, 500);
  }
});
