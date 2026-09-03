import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizeSportWizzard, type SourceRow } from "../_shared/sportwizzard.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

const adminClient = () => {
  let managedSecret = "";
  try { managedSecret = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch { /* legacy projects use the service-role variable */ }
  const secret = managedSecret || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("Supabase secret key is unavailable");
  return createClient(Deno.env.get("SUPABASE_URL")!, secret, { auth: { persistSession: false } });
};

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchAllSeasonRows(apiKey: string) {
  const endpoint = Deno.env.get("SPORTWIZZARD_API_URL") || "https://api.sportwizzard.com/api/v1/odds";
  const rows: SourceRow[] = [];
  let cursor = "";
  let pageCount = 0;
  let creditsRemaining: string | null = null;
  let creditsCost = 0;
  let creditsCostReported = false;
  const seen = new Set<string>();
  const maxPages = Math.max(1, Math.min(100, Number(Deno.env.get("VEGAS_MAX_PAGES") || 50)));
  const pageDelayMs = Math.max(0, Math.min(5000, Number(Deno.env.get("VEGAS_PAGE_DELAY_MS") || 0)));
  const requestTimeoutMs = Math.max(5000, Math.min(45000, Number(Deno.env.get("VEGAS_REQUEST_TIMEOUT_MS") || 20000)));

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("scope", "season");
    url.searchParams.set("league", "nfl");
    url.searchParams.set("market", "PLAYER_TOTAL");
    url.searchParams.set("is_main", "true");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    let response: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(url, {
        headers: { "X-Api-Key": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status !== 429 && response.status < 500) break;
      if (attempt === 3) break;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await sleep(Math.max(1000, Math.min(30000, retryAfter ? retryAfter * 1000 : 1000 * (2 ** attempt))));
    }
    if (!response?.ok) throw new Error(`SportWizzard ${response?.status || "network error"}: ${(await response?.text())?.slice(0, 500) || "request failed"}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error(`SportWizzard returned unexpected content type: ${contentType || "missing"}`);
    const payload = await response.json();
    if (!payload?.success && payload?.success !== undefined) throw new Error("SportWizzard returned success=false");
    if (!Array.isArray(payload?.data)) throw new Error("SportWizzard response is missing its data array");
    rows.push(...payload.data);
    pageCount += 1;
    creditsRemaining = response.headers.get("x-credits-remaining") || creditsRemaining;
    const pageCreditsCost = Number(response.headers.get("x-credits-cost"));
    if (Number.isFinite(pageCreditsCost)) {
      creditsCost += pageCreditsCost;
      creditsCostReported = true;
    }
    const next = String(payload?.nextCursor || payload?.meta?.nextCursor || payload?.meta?.next_cursor || "");
    if (!next) return { rows, pageCount, creditsRemaining, creditsCost: creditsCostReported ? creditsCost : null };
    if (seen.has(next)) throw new Error("SportWizzard pagination cursor repeated; snapshot rejected as incomplete");
    seen.add(next);
    cursor = next;
    if (pageDelayMs) await sleep(pageDelayMs);
  }
  throw new Error(`SportWizzard snapshot exceeded VEGAS_MAX_PAGES=${maxPages}; snapshot rejected as incomplete`);
}

Deno.serve(async request => {
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const expectedSecret = Deno.env.get("VEGAS_INGEST_SECRET");
  if (!expectedSecret || request.headers.get("x-ingest-secret") !== expectedSecret) return json({ error: "Unauthorized" }, 401);
  const apiKey = Deno.env.get("SPORTWIZZARD_API_KEY");

  const requested = await request.json().catch(() => ({}));
  const season = Number(requested?.season || new Date().getUTCFullYear());
  if (!Number.isInteger(season) || season < 2000 || season > 2100) return json({ error: "Invalid season" }, 400);

  const supabase = adminClient();
  const retrievedAt = new Date().toISOString();
  await supabase.from("vegas_ingest_runs").update({
    status: "failed",
    finished_at: retrievedAt,
    error_message: "Recovered abandoned running snapshot",
  }).eq("provider", "sportwizzard").eq("season", season).eq("status", "running")
    .lt("started_at", new Date(Date.now() - 20 * 60 * 1000).toISOString());
  const { data: run, error: runError } = await supabase.from("vegas_ingest_runs")
    .insert({ provider: "sportwizzard", season, retrieved_at: retrievedAt })
    .select("id").single();
  if (runError) return json({ error: runError.code === "23505" ? "An ingestion run is already active" : runError.message }, runError.code === "23505" ? 409 : 500);

  if (!apiKey) {
    const message = "SPORTWIZZARD_API_KEY is not configured";
    await supabase.from("vegas_ingest_runs").update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_message: message,
    }).eq("id", run.id);
    return json({ runId: run.id, error: message }, 503);
  }

  try {
    const source = await fetchAllSeasonRows(apiKey);
    const quotes = normalizeSportWizzard(source.rows, season, retrievedAt);
    const activeQuotes = quotes.filter(quote => !quote.is_suspended);
    const sourceSubtypeCounts = Object.entries(source.rows.reduce<Record<string, number>>((counts, row) => {
      const subtype = String(row.marketSubtype || "(missing)").trim() || "(missing)";
      counts[subtype] = (counts[subtype] || 0) + 1;
      return counts;
    }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
    if (!activeQuotes.length) throw new Error("The provider returned no active supported NFL regular-season player totals");
    const observedBooks = new Set(activeQuotes.map(q => q.sportsbook_key)).size;
    const observedMarkets = new Set(activeQuotes.map(q => q.market_key)).size;
    const observedPlayers = new Set(activeQuotes.map(q => q.player_key)).size;
    const normalizedMarketCounts = Object.entries(activeQuotes.reduce<Record<string, number>>((counts, quote) => {
      counts[quote.market_key] = (counts[quote.market_key] || 0) + 1;
      return counts;
    }, {})).sort((a, b) => a[0].localeCompare(b[0]));
    const minimumBooks = Number(Deno.env.get("VEGAS_MIN_BOOKS") || 2);
    const minimumQuotes = Number(Deno.env.get("VEGAS_MIN_QUOTES") || 10);
    const minimumMarkets = Number(Deno.env.get("VEGAS_MIN_MARKETS") || 2);
    const minimumPlayers = Number(Deno.env.get("VEGAS_MIN_PLAYERS") || 5);
    if (observedBooks < minimumBooks || activeQuotes.length < minimumQuotes || observedMarkets < minimumMarkets || observedPlayers < minimumPlayers) {
      throw new Error(`Coverage guard rejected the snapshot (${activeQuotes.length} active quotes, ${observedPlayers} players, ${observedMarkets} markets, ${observedBooks} books)`);
    }

    const players = [...new Map(quotes.map(q => [q.player_key, {
      player_key: q.player_key,
      provider: q.provider,
      provider_player_id: q.provider_player_id,
      display_name: q.player_name,
      team: q.team,
      position: q.position,
      updated_at: retrievedAt,
    }])).values()];
    const books = [...new Map(quotes.map(q => [q.sportsbook_key, {
      sportsbook_key: q.sportsbook_key,
      display_name: q.sportsbook_name,
      updated_at: retrievedAt,
    }])).values()];

    const playerUpsert = await supabase.from("vegas_players").upsert(players, { onConflict: "player_key" });
    if (playerUpsert.error) throw playerUpsert.error;
    const bookUpsert = await supabase.from("vegas_sportsbooks").upsert(books, { onConflict: "sportsbook_key" });
    if (bookUpsert.error) throw bookUpsert.error;

    for (let start = 0; start < quotes.length; start += 500) {
      const batch = quotes.slice(start, start + 500).map(q => ({
        run_id: run.id,
        provider: q.provider,
        season: q.season,
        player_key: q.player_key,
        market_key: q.market_key,
        sportsbook_key: q.sportsbook_key,
        line: q.line,
        over_price_american: q.over_price_american,
        under_price_american: q.under_price_american,
        provider_updated_at: q.provider_updated_at,
        retrieved_at: retrievedAt,
        source_event_id: q.source_event_id,
        source_over_id: q.source_over_id,
        source_under_id: q.source_under_id,
        is_suspended: q.is_suspended,
      }));
      const insert = await supabase.from("vegas_quotes").insert(batch);
      if (insert.error) throw insert.error;
    }

    const summary = {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      raw_row_count: source.rows.length,
      quote_count: activeQuotes.length,
      book_count: observedBooks,
      player_count: observedPlayers,
      market_count: observedMarkets,
      metadata: {
        pageCount: source.pageCount,
        normalizedQuoteCount: quotes.length,
        suspendedQuoteCount: quotes.length - activeQuotes.length,
        ignoredRowCount: Math.max(0, source.rows.length - quotes.length),
        providerCreditsCost: source.creditsCost,
        providerCreditsRemaining: source.creditsRemaining,
        sourceSubtypeCounts,
        normalizedMarketCounts,
      },
      error_message: null,
    };
    const finish = await supabase.from("vegas_ingest_runs").update(summary).eq("id", run.id);
    if (finish.error) throw finish.error;
    return json({ runId: run.id, season, retrievedAt, ...summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("vegas_ingest_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message.slice(0, 1000) }).eq("id", run.id);
    return json({ runId: run.id, error: message }, 502);
  }
});
