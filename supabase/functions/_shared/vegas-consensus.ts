import type { NormalizedQuote } from "./sportwizzard.ts";

export type ConsensusSnapshot = {
  season: number;
  player_key: string;
  market_key: string;
  consensus_line: number;
  low_line: number;
  high_line: number;
  line_range: number;
  line_iqr: number;
  line_mad: number;
  book_count: number;
  reported_book_count: number;
  outlier_book_count: number;
  sportsbooks: string[];
  excluded_sportsbooks: string[];
  paired_price_count: number;
  median_over_price: number | null;
  median_under_price: number | null;
  median_no_vig_over_probability: number | null;
  freshest_book_at: string;
  stalest_book_at: string;
  retrieved_at: string;
};

const OUTLIER_FLOOR: Record<string, number> = {
  pass_yds: 400,
  rush_yds: 250,
  rec_yds: 250,
  receptions: 20,
  pass_td: 5,
  rush_td: 5,
  rec_td: 5,
};

const round = (value: number, digits = 2) => {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

const quantile = (values: number[], probability: number) => {
  if (!values.length) throw new Error("Cannot calculate a quantile from an empty collection");
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
};

const median = (values: number[]) => quantile(values, 0.5);

const americanImpliedProbability = (price: number) => price < 0
  ? -price / (-price + 100)
  : 100 / (price + 100);

const probabilityToAmerican = (probability: number) => {
  if (!(probability > 0 && probability < 1)) return null;
  return probability >= 0.5
    ? Math.round(-100 * probability / (1 - probability))
    : Math.round(100 * (1 - probability) / probability);
};

const noVigOverProbability = (overPrice: number, underPrice: number) => {
  const over = americanImpliedProbability(overPrice);
  const under = americanImpliedProbability(underPrice);
  return over / (over + under);
};

const paired = (quote: NormalizedQuote) => quote.over_price_american !== null && quote.under_price_american !== null;

const quoteTime = (quote: NormalizedQuote, retrievedAt: string) => {
  const value = quote.provider_updated_at || retrievedAt;
  const timestamp = Date.parse(value);
  return { value, timestamp: Number.isFinite(timestamp) ? timestamp : Date.parse(retrievedAt) };
};

const preferQuote = (candidate: NormalizedQuote, incumbent: NormalizedQuote, retrievedAt: string) => {
  if (paired(candidate) !== paired(incumbent)) return paired(candidate);
  const candidateTime = quoteTime(candidate, retrievedAt).timestamp;
  const incumbentTime = quoteTime(incumbent, retrievedAt).timestamp;
  if (candidateTime !== incumbentTime) return candidateTime > incumbentTime;
  return `${candidate.source_over_id || ""}|${candidate.source_under_id || ""}`
    > `${incumbent.source_over_id || ""}|${incumbent.source_under_id || ""}`;
};

const medianAmericanPrice = (quotes: NormalizedQuote[], side: "over" | "under") => {
  const probabilities = quotes.flatMap(quote => {
    const price = side === "over" ? quote.over_price_american : quote.under_price_american;
    return price === null ? [] : [americanImpliedProbability(price)];
  });
  return probabilities.length ? probabilityToAmerican(median(probabilities)) : null;
};

export function buildConsensusSnapshots(
  quotes: NormalizedQuote[],
  retrievedAt: string,
): ConsensusSnapshot[] {
  const votes = new Map<string, NormalizedQuote>();
  for (const quote of quotes) {
    if (quote.is_suspended) continue;
    const key = `${quote.player_key}|${quote.market_key}|${quote.sportsbook_key}`;
    const incumbent = votes.get(key);
    if (!incumbent || preferQuote(quote, incumbent, retrievedAt)) votes.set(key, quote);
  }

  const groups = new Map<string, NormalizedQuote[]>();
  for (const quote of votes.values()) {
    const key = `${quote.player_key}|${quote.market_key}`;
    const group = groups.get(key) || [];
    group.push(quote);
    groups.set(key, group);
  }

  return [...groups.values()].map(group => {
    const lines = group.map(quote => quote.line);
    const center = median(lines);
    const deviations = lines.map(line => Math.abs(line - center));
    const mad = median(deviations);
    const threshold = Math.max(OUTLIER_FLOOR[group[0].market_key] ?? 5, 6 * mad);
    const canScreen = group.length >= 3;
    const core = group.filter(quote => !canScreen || Math.abs(quote.line - center) <= threshold);
    const excluded = group.filter(quote => !core.includes(quote));
    const coreLines = core.map(quote => quote.line);
    const times = core.map(quote => quoteTime(quote, retrievedAt));
    const pairedQuotes = core.filter(paired);
    const noVigProbabilities = pairedQuotes.map(quote => noVigOverProbability(
      quote.over_price_american!,
      quote.under_price_american!,
    ));
    const sortedBooks = core.map(quote => quote.sportsbook_name).sort((a, b) => a.localeCompare(b));
    const excludedBooks = excluded.map(quote => quote.sportsbook_name).sort((a, b) => a.localeCompare(b));

    return {
      season: group[0].season,
      player_key: group[0].player_key,
      market_key: group[0].market_key,
      consensus_line: round(median(coreLines)),
      low_line: round(Math.min(...coreLines)),
      high_line: round(Math.max(...coreLines)),
      line_range: round(Math.max(...coreLines) - Math.min(...coreLines)),
      line_iqr: round(quantile(coreLines, 0.75) - quantile(coreLines, 0.25)),
      line_mad: round(mad),
      book_count: core.length,
      reported_book_count: group.length,
      outlier_book_count: excluded.length,
      sportsbooks: sortedBooks,
      excluded_sportsbooks: excludedBooks,
      paired_price_count: pairedQuotes.length,
      median_over_price: medianAmericanPrice(core, "over"),
      median_under_price: medianAmericanPrice(core, "under"),
      median_no_vig_over_probability: noVigProbabilities.length ? round(median(noVigProbabilities), 5) : null,
      freshest_book_at: times.reduce((latest, item) => item.timestamp > latest.timestamp ? item : latest).value,
      stalest_book_at: times.reduce((oldest, item) => item.timestamp < oldest.timestamp ? item : oldest).value,
      retrieved_at: retrievedAt,
    };
  }).sort((a, b) => a.player_key.localeCompare(b.player_key) || a.market_key.localeCompare(b.market_key));
}
