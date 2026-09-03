create extension if not exists pgcrypto;

create table if not exists public.vegas_ingest_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  season smallint not null check (season between 2000 and 2100),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'unchanged')),
  started_at timestamptz not null default now(),
  retrieved_at timestamptz not null default now(),
  finished_at timestamptz,
  raw_row_count integer not null default 0,
  quote_count integer not null default 0,
  book_count integer not null default 0,
  player_count integer not null default 0,
  market_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  error_message text
);

create table if not exists public.vegas_players (
  player_key text primary key,
  provider text not null default 'sportwizzard',
  provider_player_id text,
  display_name text not null,
  team text,
  position text,
  updated_at timestamptz not null default now()
);

create index if not exists vegas_players_provider_id_idx
  on public.vegas_players (provider, provider_player_id)
  where provider_player_id is not null;

create table if not exists public.vegas_sportsbooks (
  sportsbook_key text primary key,
  display_name text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.vegas_markets (
  market_key text primary key,
  display_name text not null,
  unit text not null,
  yahoo_half_ppr_weight numeric not null,
  espn_half_ppr_weight numeric not null
);

insert into public.vegas_markets (market_key, display_name, unit, yahoo_half_ppr_weight, espn_half_ppr_weight)
values
  ('pass_yds', 'Passing yards', 'yards', 0.04, 0.04),
  ('pass_td', 'Passing touchdowns', 'touchdowns', 4, 4),
  ('rush_yds', 'Rushing yards', 'yards', 0.10, 0.10),
  ('rush_td', 'Rushing touchdowns', 'touchdowns', 6, 6),
  ('receptions', 'Receptions', 'receptions', 0.50, 0.50),
  ('rec_yds', 'Receiving yards', 'yards', 0.10, 0.10),
  ('rec_td', 'Receiving touchdowns', 'touchdowns', 6, 6)
on conflict (market_key) do update set
  display_name = excluded.display_name,
  unit = excluded.unit,
  yahoo_half_ppr_weight = excluded.yahoo_half_ppr_weight,
  espn_half_ppr_weight = excluded.espn_half_ppr_weight;

create table if not exists public.vegas_quotes (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.vegas_ingest_runs(id) on delete cascade,
  provider text not null,
  season smallint not null check (season between 2000 and 2100),
  player_key text not null references public.vegas_players(player_key),
  market_key text not null references public.vegas_markets(market_key),
  sportsbook_key text not null references public.vegas_sportsbooks(sportsbook_key),
  line numeric not null check (line >= 0),
  over_price_american integer,
  under_price_american integer,
  provider_updated_at timestamptz,
  retrieved_at timestamptz not null,
  source_event_id text,
  source_over_id text,
  source_under_id text,
  is_suspended boolean not null default false,
  constraint vegas_quotes_has_price check (over_price_american is not null or under_price_american is not null),
  constraint vegas_quotes_valid_over_price check (over_price_american is null or abs(over_price_american) >= 100),
  constraint vegas_quotes_valid_under_price check (under_price_american is null or abs(under_price_american) >= 100),
  constraint vegas_quotes_run_book_market_unique unique (run_id, player_key, market_key, sportsbook_key, line)
);

create index if not exists vegas_quotes_consensus_idx
  on public.vegas_quotes (run_id, season, player_key, market_key, sportsbook_key);
create index if not exists vegas_quotes_history_idx
  on public.vegas_quotes (season, player_key, market_key, retrieved_at desc);
create index if not exists vegas_ingest_runs_latest_idx
  on public.vegas_ingest_runs (season, finished_at desc)
  where status = 'succeeded' and quote_count > 0;
create unique index if not exists vegas_ingest_runs_one_running_idx
  on public.vegas_ingest_runs (provider, season)
  where status = 'running';

create or replace function public.american_implied_probability(price integer)
returns numeric
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when price < 0 then (-price)::numeric / ((-price) + 100)
    else 100::numeric / (price + 100)
  end;
$$;

create or replace function public.no_vig_over_probability(over_price integer, under_price integer)
returns numeric
language sql
immutable
strict
set search_path = ''
as $$
  select public.american_implied_probability(over_price)
    / (public.american_implied_probability(over_price) + public.american_implied_probability(under_price));
$$;

alter table public.vegas_ingest_runs enable row level security;
alter table public.vegas_players enable row level security;
alter table public.vegas_sportsbooks enable row level security;
alter table public.vegas_markets enable row level security;
alter table public.vegas_quotes enable row level security;

revoke all on public.vegas_ingest_runs from anon, authenticated;
revoke all on public.vegas_players from anon, authenticated;
revoke all on public.vegas_sportsbooks from anon, authenticated;
revoke all on public.vegas_markets from anon, authenticated;
revoke all on public.vegas_quotes from anon, authenticated;

create or replace view public.vegas_quote_detail_current
with (security_invoker = true)
as
with latest_run as (
  select distinct on (season) id, season, retrieved_at
  from public.vegas_ingest_runs
  where status = 'succeeded' and quote_count > 0
  order by season, finished_at desc
)
select
  q.season,
  q.player_key,
  p.display_name as player_name,
  p.team,
  p.position,
  q.market_key,
  m.display_name as market_name,
  q.sportsbook_key,
  b.display_name as sportsbook_name,
  q.line,
  q.over_price_american,
  q.under_price_american,
  q.provider_updated_at,
  q.retrieved_at
from public.vegas_quotes q
join latest_run r on r.id = q.run_id
join public.vegas_players p on p.player_key = q.player_key
join public.vegas_markets m on m.market_key = q.market_key
join public.vegas_sportsbooks b on b.sportsbook_key = q.sportsbook_key
where not q.is_suspended;

create or replace view public.vegas_consensus_history
with (security_invoker = true)
as
with one_vote_per_book as (
  select q.*,
    row_number() over (
      partition by q.run_id, q.player_key, q.market_key, q.sportsbook_key
      order by
        (q.over_price_american is not null and q.under_price_american is not null) desc,
        coalesce(q.provider_updated_at, q.retrieved_at) desc,
        q.id desc
    ) as book_row
  from public.vegas_quotes q
  join public.vegas_ingest_runs r on r.id = q.run_id
  where r.status = 'succeeded' and r.quote_count > 0 and not q.is_suspended
)
select
  q.run_id,
  r.retrieved_at as run_retrieved_at,
  q.season,
  q.player_key,
  p.display_name as player_name,
  p.team,
  p.position,
  q.market_key,
  m.display_name as market_name,
  m.unit,
  m.yahoo_half_ppr_weight,
  m.espn_half_ppr_weight,
  (percentile_cont(0.5) within group (order by q.line::double precision))::numeric(12,2) as consensus_line,
  min(q.line)::numeric(12,2) as low_line,
  max(q.line)::numeric(12,2) as high_line,
  (max(q.line) - min(q.line))::numeric(12,2) as line_range,
  (
    percentile_cont(0.75) within group (order by q.line::double precision)
    - percentile_cont(0.25) within group (order by q.line::double precision)
  )::numeric(12,2) as line_iqr,
  count(*)::integer as book_count,
  array_agg(b.display_name order by b.display_name) as sportsbooks,
  (count(*) filter (where q.over_price_american is not null and q.under_price_american is not null))::integer as paired_price_count,
  (percentile_cont(0.5) within group (order by q.over_price_american::double precision)
    filter (where q.over_price_american is not null))::numeric(12,2) as median_over_price,
  (percentile_cont(0.5) within group (order by q.under_price_american::double precision)
    filter (where q.under_price_american is not null))::numeric(12,2) as median_under_price,
  (percentile_cont(0.5) within group (
    order by public.no_vig_over_probability(q.over_price_american, q.under_price_american)::double precision
  ) filter (
    where q.over_price_american is not null and q.under_price_american is not null
  ))::numeric(8,5) as median_no_vig_over_probability,
  max(coalesce(q.provider_updated_at, q.retrieved_at)) as freshest_book_at,
  min(coalesce(q.provider_updated_at, q.retrieved_at)) as stalest_book_at,
  max(q.retrieved_at) as retrieved_at
from one_vote_per_book q
join public.vegas_ingest_runs r on r.id = q.run_id
join public.vegas_players p on p.player_key = q.player_key
join public.vegas_markets m on m.market_key = q.market_key
join public.vegas_sportsbooks b on b.sportsbook_key = q.sportsbook_key
where q.book_row = 1
group by q.run_id, r.retrieved_at, q.season, q.player_key, p.display_name, p.team, p.position,
  q.market_key, m.display_name, m.unit, m.yahoo_half_ppr_weight, m.espn_half_ppr_weight;

create or replace view public.vegas_consensus_current
with (security_invoker = true)
as
with ranked as (
  select h.*,
    row_number() over (partition by h.season, h.player_key, h.market_key order by h.run_retrieved_at desc) as recency
  from public.vegas_consensus_history h
), current_rows as (
  select * from ranked where recency = 1
), enriched as (
  select
    c.*,
    previous.consensus_line as previous_consensus_line,
    (c.consensus_line - previous.consensus_line)::numeric(12,2) as line_change_previous,
    day_ago.consensus_line as consensus_line_24h_ago,
    (c.consensus_line - day_ago.consensus_line)::numeric(12,2) as line_change_24h
  from current_rows c
  left join lateral (
    select h.consensus_line
    from public.vegas_consensus_history h
    where h.season = c.season and h.player_key = c.player_key and h.market_key = c.market_key
      and h.run_retrieved_at < c.run_retrieved_at
    order by h.run_retrieved_at desc
    limit 1
  ) previous on true
  left join lateral (
    select h.consensus_line
    from public.vegas_consensus_history h
    where h.season = c.season and h.player_key = c.player_key and h.market_key = c.market_key
      and h.run_retrieved_at <= c.run_retrieved_at - interval '24 hours'
    order by h.run_retrieved_at desc
    limit 1
  ) day_ago on true
), scored as (
  select e.*,
    least(100, greatest(0,
      least(e.book_count, 5) * 9
      + least(15, round(15 * e.paired_price_count::numeric / nullif(e.book_count, 0)))
      + case
          when e.freshest_book_at >= now() - interval '2 hours' then 12
          when e.freshest_book_at >= now() - interval '6 hours' then 8
          when e.freshest_book_at >= now() - interval '24 hours' then 4
          else 0
        end
      + case
          when e.stalest_book_at >= now() - interval '6 hours' then 8
          when e.stalest_book_at >= now() - interval '24 hours' then 4
          else 0
        end
      + case
          when e.unit = 'yards' and e.line_iqr <= 25 then 20
          when e.unit = 'yards' and e.line_iqr <= 75 then 12
          when e.unit = 'touchdowns' and e.line_iqr <= 1 then 20
          when e.unit = 'touchdowns' and e.line_iqr <= 2 then 12
          when e.unit = 'receptions' and e.line_iqr <= 5 then 20
          when e.unit = 'receptions' and e.line_iqr <= 10 then 12
          else 4
        end
    ))::integer as quote_quality_score
  from enriched e
)
select
  s.season,
  s.player_key,
  s.player_name,
  s.team,
  s.position,
  s.market_key,
  s.market_name,
  s.unit,
  s.yahoo_half_ppr_weight,
  s.espn_half_ppr_weight,
  s.consensus_line,
  s.low_line,
  s.high_line,
  s.line_range,
  s.line_iqr,
  s.book_count,
  s.sportsbooks,
  s.paired_price_count,
  s.median_over_price,
  s.median_under_price,
  s.median_no_vig_over_probability,
  s.freshest_book_at,
  s.stalest_book_at,
  s.retrieved_at,
  s.previous_consensus_line,
  s.line_change_previous,
  s.consensus_line_24h_ago,
  s.line_change_24h,
  s.quote_quality_score,
  case
    when s.quote_quality_score >= 80 then 'strong'
    when s.quote_quality_score >= 60 then 'usable'
    when s.quote_quality_score >= 40 then 'thin'
    else 'weak'
  end as confidence_label,
  case
    when s.retrieved_at < now() - interval '24 hours' then 'stale'
    when s.stalest_book_at < now() - interval '24 hours' then 'mixed-age'
    else 'current'
  end as freshness_status,
  case
    when s.unit = 'yards' and s.line_iqr <= 25 then 'tight'
    when s.unit = 'yards' and s.line_iqr <= 75 then 'mixed'
    when s.unit = 'touchdowns' and s.line_iqr <= 1 then 'tight'
    when s.unit = 'touchdowns' and s.line_iqr <= 2 then 'mixed'
    when s.unit = 'receptions' and s.line_iqr <= 5 then 'tight'
    when s.unit = 'receptions' and s.line_iqr <= 10 then 'mixed'
    else 'wide'
  end as dispersion_status,
  case
    when s.line_change_24h > 0 then 'rising'
    when s.line_change_24h < 0 then 'falling'
    when s.line_change_24h = 0 then 'flat'
    else 'new'
  end as consensus_direction,
  case
    when s.median_no_vig_over_probability >= 0.525 then 'over'
    when s.median_no_vig_over_probability <= 0.475 then 'under'
    when s.median_no_vig_over_probability is not null then 'balanced'
    else 'unpriced'
  end as price_lean
from scored s;

create or replace view public.vegas_pipeline_health
with (security_invoker = true)
as
with seasons as (
  select distinct season from public.vegas_ingest_runs
), latest as (
  select distinct on (season)
    season, id as latest_run_id, status as latest_status, started_at as latest_started_at,
    finished_at as latest_finished_at, error_message as latest_error
  from public.vegas_ingest_runs
  order by season, started_at desc
), successes as (
  select distinct on (season)
    season, id as last_successful_run_id, retrieved_at as last_success_at,
    quote_count, book_count, player_count, market_count
  from public.vegas_ingest_runs
  where status = 'succeeded' and quote_count > 0
  order by season, finished_at desc
)
select
  s.season,
  l.latest_run_id,
  l.latest_status,
  l.latest_started_at,
  l.latest_finished_at,
  l.latest_error,
  ok.last_successful_run_id,
  ok.last_success_at,
  extract(epoch from (now() - ok.last_success_at)) / 60 as minutes_since_success,
  ok.quote_count,
  ok.book_count,
  ok.player_count,
  ok.market_count,
  (
    select count(*)::integer
    from public.vegas_ingest_runs f
    where f.season = s.season and f.status = 'failed'
      and f.started_at > coalesce(ok.last_success_at, '-infinity'::timestamptz)
  ) as consecutive_failures
from seasons s
join latest l using (season)
left join successes ok using (season);

create or replace function public.prune_vegas_history(keep_days integer default 120, keep_successful_runs integer default 50)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_rows bigint;
begin
  if keep_days < 7 or keep_successful_runs < 2 then
    raise exception 'Retention must preserve at least 7 days and 2 successful runs';
  end if;

  delete from public.vegas_ingest_runs r
  where r.status <> 'running'
    and r.finished_at < now() - make_interval(days => keep_days)
    and r.id not in (
      select keep.id
      from public.vegas_ingest_runs keep
      where keep.season = r.season and keep.status = 'succeeded' and keep.quote_count > 0
      order by keep.finished_at desc
      limit keep_successful_runs
    );

  get diagnostics deleted_rows = row_count;
  return deleted_rows;
end;
$$;

revoke all on public.vegas_quote_detail_current from anon, authenticated;
revoke all on public.vegas_consensus_history from anon, authenticated;
revoke all on public.vegas_consensus_current from anon, authenticated;
revoke all on public.vegas_pipeline_health from anon, authenticated;
revoke all on function public.prune_vegas_history(integer, integer) from public, anon, authenticated;
grant select on public.vegas_quote_detail_current to service_role;
grant select on public.vegas_consensus_history to service_role;
grant select on public.vegas_consensus_current to service_role;
grant select on public.vegas_pipeline_health to service_role;
grant execute on function public.prune_vegas_history(integer, integer) to service_role;

comment on view public.vegas_consensus_current is
  'One-vote-per-book median for NFL regular-season player totals from the latest complete ingestion run, with price lean, dispersion, movement, freshness, and quality.';
comment on view public.vegas_pipeline_health is
  'Operational health for the season-props ingestion pipeline. Only service-role callers may read it.';
comment on function public.prune_vegas_history(integer, integer) is
  'Deletes old completed ingestion runs while retaining a minimum number of successful snapshots per season.';
