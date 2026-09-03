import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedQuote } from "../supabase/functions/_shared/sportwizzard.ts";
import { buildConsensusSnapshots } from "../supabase/functions/_shared/vegas-consensus.ts";

const retrievedAt = "2026-09-03T18:30:00Z";

const quote = (book: string, line: number, overrides: Partial<NormalizedQuote> = {}): NormalizedQuote => ({
  provider: "sportwizzard",
  season: 2026,
  player_key: "exampleplayer",
  provider_player_id: "player-1",
  player_name: "Example Player",
  team: "Example Team",
  position: "RB",
  market_key: "rush_yds",
  sportsbook_key: book.toLowerCase(),
  sportsbook_name: book,
  line,
  over_price_american: -110,
  under_price_american: -110,
  provider_updated_at: retrievedAt,
  source_event_id: "season-2026",
  source_over_id: `${book}-over`,
  source_under_id: `${book}-under`,
  is_suspended: false,
  ...overrides,
});

test("screens an isolated malformed book line without hiding reporting breadth", () => {
  const [snapshot] = buildConsensusSnapshots([
    quote("DraftKings", 700.5),
    quote("FanDuel", 700.5),
    quote("Pinnacle", 725.5),
    quote("Fanatics", 1499.5),
  ], retrievedAt);
  assert.equal(snapshot.consensus_line, 700.5);
  assert.equal(snapshot.high_line, 725.5);
  assert.equal(snapshot.book_count, 3);
  assert.equal(snapshot.reported_book_count, 4);
  assert.equal(snapshot.outlier_book_count, 1);
  assert.deepEqual(snapshot.excluded_sportsbooks, ["Fanatics"]);
});

test("does not choose a winner when only two books materially disagree", () => {
  const [snapshot] = buildConsensusSnapshots([
    quote("DraftKings", 500.5),
    quote("FanDuel", 1000.5),
  ], retrievedAt);
  assert.equal(snapshot.consensus_line, 750.5);
  assert.equal(snapshot.book_count, 2);
  assert.equal(snapshot.outlier_book_count, 0);
});

test("deduplicates a book and prefers its paired, newer primary quote", () => {
  const [snapshot] = buildConsensusSnapshots([
    quote("DraftKings", 700.5, { provider_updated_at: "2026-09-03T18:29:00Z" }),
    quote("DraftKings", 725.5, { provider_updated_at: "2026-09-03T18:28:00Z", under_price_american: null }),
    quote("FanDuel", 700.5),
  ], retrievedAt);
  assert.equal(snapshot.reported_book_count, 2);
  assert.equal(snapshot.consensus_line, 700.5);
  assert.equal(snapshot.paired_price_count, 2);
});

test("aggregates American prices in probability space", () => {
  const [snapshot] = buildConsensusSnapshots([
    quote("DraftKings", 700.5, { over_price_american: -120, under_price_american: 105 }),
    quote("FanDuel", 700.5, { over_price_american: 105, under_price_american: -120 }),
  ], retrievedAt);
  assert.ok(snapshot.median_over_price !== null && Math.abs(snapshot.median_over_price) >= 100);
  assert.ok(snapshot.median_under_price !== null && Math.abs(snapshot.median_under_price) >= 100);
  assert.equal(snapshot.median_no_vig_over_probability, 0.5);
});
