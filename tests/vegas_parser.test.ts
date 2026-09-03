import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMarket, normalizeSportWizzard, playerKey } from "../supabase/functions/_shared/sportwizzard.ts";

test("normalizes the supported NFL season markets", () => {
  assert.equal(normalizeMarket("PLAYER_TOTAL_PASSING_YARDS"), "pass_yds");
  assert.equal(normalizeMarket("PLAYER_TOTAL_PASSING_TOUCHDOWNS"), "pass_td");
  assert.equal(normalizeMarket("PLAYER_TOTAL_RUSHING_YARDS"), "rush_yds");
  assert.equal(normalizeMarket("PLAYER_TOTAL_RUSHING_TDS"), "rush_td");
  assert.equal(normalizeMarket("PLAYER_TOTAL_RECEIVING_YARDS"), "rec_yds");
  assert.equal(normalizeMarket("PLAYER_TOTAL_REC_YARDS"), "rec_yds");
  assert.equal(normalizeMarket("PLAYER_TOTAL_RECEIVING_TOUCHDOWNS"), "rec_td");
  assert.equal(normalizeMarket("PLAYER_TOTAL_RECEPTIONS"), "receptions");
  assert.equal(normalizeMarket("PLAYER_TOTAL_PASSING_ATTEMPTS"), null);
  assert.equal(normalizeMarket("PLAYER_TOTAL_RUSHING_AND_RECEIVING_YARDS"), null);
});

test("pairs over and under prices without admitting game props", () => {
  const common = {
    marketScope: "SEASON",
    period: "REG_SEASON",
    market: "PLAYER_TOTAL",
    marketSubtype: "PLAYER_TOTAL_RECEPTIONS",
    playerId: "puka-id",
    playerName: "Puka Nacua",
    teamName: "LAR Rams",
    sportsbook: "fanduel",
    sportsbookName: "FanDuel",
    line: 107.5,
    eventId: "season-2026",
    updated: "2026-09-03T05:12:00Z",
  };
  const rows = [
    { ...common, id: "over-id", side: "OVER", priceAmerican: -108 },
    { ...common, id: "under-id", side: "UNDER", priceAmerican: -112 },
    { ...common, id: "game-id", marketScope: "EVENT", side: "OVER", priceAmerican: -110 },
  ];
  const quotes = normalizeSportWizzard(rows, 2026, "2026-09-03T05:15:00Z");
  assert.equal(quotes.length, 1);
  assert.deepEqual(quotes[0], {
    provider: "sportwizzard",
    season: 2026,
    player_key: "pukanacua",
    provider_player_id: "puka-id",
    player_name: "Puka Nacua",
    team: "LAR Rams",
    position: null,
    market_key: "receptions",
    sportsbook_key: "fanduel",
    sportsbook_name: "FanDuel",
    line: 107.5,
    over_price_american: -108,
    under_price_american: -112,
    provider_updated_at: "2026-09-03T05:12:00Z",
    source_event_id: "season-2026",
    source_over_id: "over-id",
    source_under_id: "under-id",
    is_suspended: false,
  });
});

test("player keys tolerate suffix and punctuation differences", () => {
  assert.equal(playerKey("James Cook III"), playerKey("James Cook"));
  assert.equal(playerKey("A.J. Brown"), "ajbrown");
  assert.equal(playerKey("José Núñez Jr."), "josenunez");
});

test("rejects malformed prices and implausible season lines", () => {
  const base = {
    marketScope: "SEASON", period: "REG_SEASON", market: "PLAYER_TOTAL",
    marketSubtype: "PLAYER_TOTAL_PASSING_YARDS", playerName: "Example Quarterback",
    sportsbook: "sharp-book", side: "OVER",
  };
  const quotes = normalizeSportWizzard([
    { ...base, line: 3999.5, priceAmerican: -110 },
    { ...base, sportsbook: "bad-price", line: 3999.5, priceAmerican: -99 },
    { ...base, sportsbook: "bad-line", line: 9999.5, priceAmerican: -110 },
    { ...base, sportsbook: "game-row", marketScope: "EVENT", line: 265.5, priceAmerican: -110 },
  ], 2026, "2026-09-03T05:15:00Z");
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].sportsbook_name, "Sharp Book");
});

test("retains suspension state so consensus can exclude locked quotes", () => {
  const common = {
    marketScope: "SEASON", period: "REG_SEASON", market: "PLAYER_TOTAL",
    marketSubtype: "PLAYER_TOTAL_RUSHING_TOUCHDOWNS", playerName: "Example Runner",
    sportsbook: "fanduel", line: 8.5, suspended: true,
  };
  const [quote] = normalizeSportWizzard([
    { ...common, side: "OVER", priceAmerican: -110 },
    { ...common, side: "UNDER", priceAmerican: -110 },
  ], 2026, "2026-09-03T05:15:00Z");
  assert.equal(quote.is_suspended, true);
  assert.equal(quote.over_price_american, -110);
  assert.equal(quote.under_price_american, -110);
});
