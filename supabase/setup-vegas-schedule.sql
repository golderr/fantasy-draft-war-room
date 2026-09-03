-- Run after deploying both Edge Functions and storing the secrets shown below.
-- Replace the two placeholder values before executing this script in Supabase SQL Editor.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

do $$
begin
  if 'REPLACE_WITH_THE_SAME_LONG_RANDOM_VALUE_AS_VEGAS_INGEST_SECRET' like 'REPLACE_%' then
    raise exception 'Replace the VEGAS_INGEST_SECRET placeholder before running this script';
  end if;
end $$;

select vault.create_secret(
  'https://lodxwbklcvfwkgqyvuha.supabase.co',
  'vegas_project_url',
  'Base URL used by the scheduled Vegas ingestion job'
)
where not exists (select 1 from vault.decrypted_secrets where name = 'vegas_project_url');

select vault.create_secret(
  'REPLACE_WITH_THE_SAME_LONG_RANDOM_VALUE_AS_VEGAS_INGEST_SECRET',
  'vegas_ingest_secret',
  'Shared secret used only by pg_cron to invoke ingest-vegas'
)
where not exists (select 1 from vault.decrypted_secrets where name = 'vegas_ingest_secret');

do $$
begin
  if exists (select 1 from cron.job where jobname = 'refresh-nfl-season-props') then
    perform cron.unschedule('refresh-nfl-season-props');
  end if;
  if exists (select 1 from cron.job where jobname = 'prune-nfl-season-props') then
    perform cron.unschedule('prune-nfl-season-props');
  end if;
end $$;

select cron.schedule(
  'refresh-nfl-season-props',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'vegas_project_url')
      || '/functions/v1/ingest-vegas',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-ingest-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'vegas_ingest_secret')
    ),
    body := jsonb_build_object(
      'season',
      case when extract(month from now()) <= 2 then extract(year from now())::integer - 1 else extract(year from now())::integer end
    ),
    timeout_milliseconds := 120000
  );
  $$
);

select cron.schedule(
  'prune-nfl-season-props',
  '17 8 * * *',
  $$select public.prune_vegas_history(120, 50);$$
);

-- Read-only operational checks. Failed or incomplete refreshes never replace the last good board.
-- select * from public.vegas_pipeline_health;
-- select * from cron.job where jobname in ('refresh-nfl-season-props', 'prune-nfl-season-props');
