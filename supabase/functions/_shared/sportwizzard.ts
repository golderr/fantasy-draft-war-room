export type SourceRow = Record<string, unknown>;

export type NormalizedQuote = {
  provider: "sportwizzard";
  season: number;
  player_key: string;
  provider_player_id: string | null;
  player_name: string;
  team: string | null;
  position: string | null;
  market_key: string;
  sportsbook_key: string;
  sportsbook_name: string;
  line: number;
  over_price_american: number | null;
  under_price_american: number | null;
  provider_updated_at: string | null;
  source_event_id: string | null;
  source_over_id: string | null;
  source_under_id: string | null;
  is_suspended: boolean;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const finite = (value: unknown) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const americanPrice = (value: unknown) => {
  const number = finite(value);
  if (number === null || Math.abs(number) < 100 || Math.abs(number) > 100000) return null;
  return Math.round(number);
};

const lineIsPlausible = (market: string, line: number) => {
  const limits: Record<string, [number, number]> = {
    pass_yds: [250, 6500], pass_td: [0.5, 70], rush_yds: [10, 3000], rush_td: [0.5, 35],
    receptions: [1, 220], rec_yds: [10, 3000], rec_td: [0.5, 35],
  };
  const range = limits[market];
  return Boolean(range && line >= range[0] && line <= range[1]);
};

const sportsbookName = (row: SourceRow, key: string) => text(row.sportsbookName) || key
  .split(/[-_]/)
  .filter(Boolean)
  .map(part => part.charAt(0).toUpperCase() + part.slice(1))
  .join(" ");

export const playerKey = (name: string) => name
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
  .replace(/[^a-z0-9]/g, "");

export const normalizeMarket = (subtypeValue: unknown) => {
  const subtype = text(subtypeValue).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!subtype.includes("PLAYER") || !subtype.includes("TOTAL")) return null;
  if (subtype.includes("RUSH") && (subtype.includes("RECEIV") || subtype.includes("SCRIMMAGE"))) return null;
  if (/PASS(ING)?_YARDS?/.test(subtype)) return "pass_yds";
  if (/PASS(ING)?_(TOUCHDOWNS?|TDS?)$/.test(subtype)) return "pass_td";
  if (/RUSH(ING)?_YARDS?/.test(subtype)) return "rush_yds";
  if (/RUSH(ING)?_(TOUCHDOWNS?|TDS?)$/.test(subtype)) return "rush_td";
  if (/(RECEPTION|RECEIVING)_YARDS?/.test(subtype)) return "rec_yds";
  if (/(RECEPTION|RECEIVING)_(TOUCHDOWNS?|TDS?)$/.test(subtype)) return "rec_td";
  if (/(TOTAL_)?RECEPTIONS?$/.test(subtype)) return "receptions";
  return null;
};

export function normalizeSportWizzard(rows: SourceRow[], season: number, retrievedAt: string): NormalizedQuote[] {
  const pairs = new Map<string, NormalizedQuote>();

  for (const row of rows) {
    if (text(row.marketScope).toUpperCase() !== "SEASON") continue;
    if (text(row.period).toUpperCase() !== "REG_SEASON") continue;
    if (text(row.market) && text(row.market).toUpperCase() !== "PLAYER_TOTAL") continue;
    const side = text(row.side).toUpperCase();
    if (side !== "OVER" && side !== "UNDER") continue;
    const marketKey = normalizeMarket(row.marketSubtype);
    const playerName = text(row.playerName);
    const sportsbookKey = text(row.sportsbook).toLowerCase();
    const line = finite(row.line);
    const price = americanPrice(row.priceAmerican);
    if (!marketKey || !playerName || !sportsbookKey || line === null || price === null || !lineIsPlausible(marketKey, line)) continue;

    const key = [text(row.playerId) || playerKey(playerName), marketKey, sportsbookKey, line].join("|");
    const quote = pairs.get(key) || {
      provider: "sportwizzard" as const,
      season,
      player_key: playerKey(playerName),
      provider_player_id: text(row.playerId) || null,
      player_name: playerName,
      team: text(row.teamName) || null,
      position: text(row.playerPosition) || text(row.position) || null,
      market_key: marketKey,
      sportsbook_key: sportsbookKey,
      sportsbook_name: sportsbookName(row, sportsbookKey),
      line,
      over_price_american: null,
      under_price_american: null,
      provider_updated_at: text(row.updated) || null,
      source_event_id: text(row.eventId) || null,
      source_over_id: null,
      source_under_id: null,
      is_suspended: Boolean(row.suspended),
    };

    if (side === "OVER") {
      quote.over_price_american = price;
      quote.source_over_id = text(row.id) || null;
    } else {
      quote.under_price_american = price;
      quote.source_under_id = text(row.id) || null;
    }
    const updated = text(row.updated);
    if (updated && (!quote.provider_updated_at || updated > quote.provider_updated_at)) quote.provider_updated_at = updated;
    quote.is_suspended = quote.is_suspended || Boolean(row.suspended);
    pairs.set(key, quote);
  }

  return [...pairs.values()].filter(quote => quote.over_price_american !== null || quote.under_price_american !== null)
    .map(quote => ({ ...quote, provider_updated_at: quote.provider_updated_at || retrievedAt }));
}
