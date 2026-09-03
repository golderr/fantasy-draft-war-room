create table if not exists public.vegas_consensus_snapshots (
  run_id uuid not null references public.vegas_ingest_runs(id) on delete cascade,
  season smallint not null check (season between 2000 and 2100),
  player_key text not null references public.vegas_players(player_key),
  market_key text not null references public.vegas_markets(market_key),
  consensus_line numeric(12,2) not null,
  low_line numeric(12,2) not null,
  high_line numeric(12,2) not null,
  line_range numeric(12,2) not null check (line_range >= 0),
  line_iqr numeric(12,2) not null check (line_iqr >= 0),
  line_mad numeric(12,2) not null check (line_mad >= 0),
  book_count integer not null check (book_count > 0),
  reported_book_count integer not null check (reported_book_count >= book_count),
  outlier_book_count integer not null check (outlier_book_count = reported_book_count - book_count),
  sportsbooks text[] not null,
  excluded_sportsbooks text[] not null default '{}',
  paired_price_count integer not null check (paired_price_count between 0 and book_count),
  median_over_price numeric(12,2),
  median_under_price numeric(12,2),
  median_no_vig_over_probability numeric(8,5),
  freshest_book_at timestamptz not null,
  stalest_book_at timestamptz not null,
  retrieved_at timestamptz not null,
  primary key (run_id, player_key, market_key)
);

create index if not exists vegas_consensus_snapshots_current_idx
  on public.vegas_consensus_snapshots (season, retrieved_at desc, player_key, market_key);
create index if not exists vegas_consensus_snapshots_history_idx
  on public.vegas_consensus_snapshots (season, player_key, market_key, retrieved_at desc);

alter table public.vegas_consensus_snapshots enable row level security;
revoke all on public.vegas_consensus_snapshots from anon, authenticated;

create or replace view public.vegas_consensus_materialized_history
with (security_invoker = true)
as
select
  snapshot.run_id,
  run.retrieved_at as run_retrieved_at,
  snapshot.season,
  snapshot.player_key,
  player.display_name as player_name,
  player.team,
  player.position,
  snapshot.market_key,
  market.display_name as market_name,
  market.unit,
  market.yahoo_half_ppr_weight,
  market.espn_half_ppr_weight,
  snapshot.consensus_line,
  snapshot.low_line,
  snapshot.high_line,
  snapshot.line_range,
  snapshot.line_iqr,
  snapshot.book_count,
  snapshot.sportsbooks,
  snapshot.paired_price_count,
  snapshot.median_over_price,
  snapshot.median_under_price,
  snapshot.median_no_vig_over_probability,
  snapshot.freshest_book_at,
  snapshot.stalest_book_at,
  snapshot.retrieved_at,
  snapshot.reported_book_count,
  snapshot.outlier_book_count,
  snapshot.excluded_sportsbooks,
  snapshot.line_mad
from public.vegas_consensus_snapshots snapshot
join public.vegas_ingest_runs run on run.id = snapshot.run_id
join public.vegas_players player on player.player_key = snapshot.player_key
join public.vegas_markets market on market.market_key = snapshot.market_key
where run.status = 'succeeded' and run.quote_count > 0;

create or replace view public.vegas_consensus_materialized_current
with (security_invoker = true)
as
with current_runs as (
  select distinct on (run.season) run.id, run.season, run.retrieved_at, run.finished_at
  from public.vegas_ingest_runs run
  where run.status = 'succeeded' and run.quote_count > 0
    and exists (select 1 from public.vegas_consensus_snapshots snapshot where snapshot.run_id = run.id)
  order by run.season, run.finished_at desc
), run_context as (
  select current.id as current_run_id, current.season,
    (
      select previous.id
      from public.vegas_ingest_runs previous
      where previous.season = current.season
        and previous.status = 'succeeded' and previous.quote_count > 0
        and previous.finished_at < current.finished_at
        and exists (select 1 from public.vegas_consensus_snapshots snapshot where snapshot.run_id = previous.id)
      order by previous.finished_at desc
      limit 1
    ) as previous_run_id,
    (
      select day_ago.id
      from public.vegas_ingest_runs day_ago
      where day_ago.season = current.season
        and day_ago.status = 'succeeded' and day_ago.quote_count > 0
        and day_ago.retrieved_at <= current.retrieved_at - interval '24 hours'
        and exists (select 1 from public.vegas_consensus_snapshots snapshot where snapshot.run_id = day_ago.id)
      order by day_ago.retrieved_at desc
      limit 1
    ) as day_ago_run_id
  from current_runs current
), enriched as (
  select
    current.*,
    previous.consensus_line as previous_consensus_line,
    (current.consensus_line - previous.consensus_line)::numeric(12,2) as line_change_previous,
    day_ago.consensus_line as consensus_line_24h_ago,
    (current.consensus_line - day_ago.consensus_line)::numeric(12,2) as line_change_24h
  from run_context context
  join public.vegas_consensus_snapshots current on current.run_id = context.current_run_id
  left join public.vegas_consensus_snapshots previous
    on previous.run_id = context.previous_run_id
    and previous.player_key = current.player_key and previous.market_key = current.market_key
  left join public.vegas_consensus_snapshots day_ago
    on day_ago.run_id = context.day_ago_run_id
    and day_ago.player_key = current.player_key and day_ago.market_key = current.market_key
), scored as (
  select enriched.*,
    least(100, greatest(0,
      least(enriched.book_count, 5) * 9
      + least(15, round(15 * enriched.paired_price_count::numeric / nullif(enriched.book_count, 0)))
      + case
          when enriched.freshest_book_at >= now() - interval '2 hours' then 12
          when enriched.freshest_book_at >= now() - interval '6 hours' then 8
          when enriched.freshest_book_at >= now() - interval '24 hours' then 4
          else 0
        end
      + case
          when enriched.stalest_book_at >= now() - interval '6 hours' then 8
          when enriched.stalest_book_at >= now() - interval '24 hours' then 4
          else 0
        end
      + case
          when market.unit = 'yards' and enriched.line_iqr <= 25 then 20
          when market.unit = 'yards' and enriched.line_iqr <= 75 then 12
          when market.unit = 'touchdowns' and enriched.line_iqr <= 1 then 20
          when market.unit = 'touchdowns' and enriched.line_iqr <= 2 then 12
          when market.unit = 'receptions' and enriched.line_iqr <= 5 then 20
          when market.unit = 'receptions' and enriched.line_iqr <= 10 then 12
          else 4
        end
      - least(16, enriched.outlier_book_count * 4)
    ))::integer as quote_quality_score
  from enriched
  join public.vegas_markets market on market.market_key = enriched.market_key
)
select
  scored.season,
  scored.player_key,
  player.display_name as player_name,
  player.team,
  player.position,
  scored.market_key,
  market.display_name as market_name,
  market.unit,
  market.yahoo_half_ppr_weight,
  market.espn_half_ppr_weight,
  scored.consensus_line,
  scored.low_line,
  scored.high_line,
  scored.line_range,
  scored.line_iqr,
  scored.book_count,
  scored.sportsbooks,
  scored.paired_price_count,
  scored.median_over_price,
  scored.median_under_price,
  scored.median_no_vig_over_probability,
  scored.freshest_book_at,
  scored.stalest_book_at,
  scored.retrieved_at,
  scored.previous_consensus_line,
  scored.line_change_previous,
  scored.consensus_line_24h_ago,
  scored.line_change_24h,
  scored.quote_quality_score,
  case
    when scored.quote_quality_score >= 80 then 'strong'
    when scored.quote_quality_score >= 60 then 'usable'
    when scored.quote_quality_score >= 40 then 'thin'
    else 'weak'
  end as confidence_label,
  case
    when scored.retrieved_at < now() - interval '24 hours' then 'stale'
    when scored.stalest_book_at < now() - interval '24 hours' then 'mixed-age'
    else 'current'
  end as freshness_status,
  case
    when market.unit = 'yards' and scored.line_iqr <= 25 then 'tight'
    when market.unit = 'yards' and scored.line_iqr <= 75 then 'mixed'
    when market.unit = 'touchdowns' and scored.line_iqr <= 1 then 'tight'
    when market.unit = 'touchdowns' and scored.line_iqr <= 2 then 'mixed'
    when market.unit = 'receptions' and scored.line_iqr <= 5 then 'tight'
    when market.unit = 'receptions' and scored.line_iqr <= 10 then 'mixed'
    else 'wide'
  end as dispersion_status,
  case
    when scored.line_change_24h > 0 then 'rising'
    when scored.line_change_24h < 0 then 'falling'
    when scored.line_change_24h = 0 then 'flat'
    else 'new'
  end as consensus_direction,
  case
    when scored.median_no_vig_over_probability >= 0.525 then 'over'
    when scored.median_no_vig_over_probability <= 0.475 then 'under'
    when scored.median_no_vig_over_probability is not null then 'balanced'
    else 'unpriced'
  end as price_lean,
  scored.reported_book_count,
  scored.outlier_book_count,
  scored.excluded_sportsbooks,
  scored.line_mad
from scored
join public.vegas_players player on player.player_key = scored.player_key
join public.vegas_markets market on market.market_key = scored.market_key;

comment on table public.vegas_consensus_snapshots is
  'Precomputed, outlier-aware sportsbook consensus per successful ingest run. Raw quote snapshots remain the audit trail.';
comment on view public.vegas_consensus_materialized_current is
  'Fast current consensus with prior and 24-hour movement, evidence quality, reporting breadth, and transparent outlier screening.';

notify pgrst, 'reload schema';
