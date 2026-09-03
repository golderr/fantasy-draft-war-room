# Fantasy Draft War Room

A fast, phone-friendly 2026 snake-draft board for Yahoo Public half-PPR and ESPN half-PPR leagues. It combines room-specific ADP, a private decision rank, projections, roster construction, pick-survival logic, and a separately labeled Vegas evidence layer.

## Multi-book Vegas intelligence

The live layer is deliberately not a single sportsbook line and not a disguised projection:

```text
SportWizzard NFL season feed
        ↓
ingest-vegas Edge Function
        ↓
immutable run + quote snapshots in Supabase
        ↓
one vote per book → median consensus + prices + movement + disagreement
        ↓
vegas-consensus Edge Function
        ↓
compact board cue; evidence-rich tooltip; guarded recommendation adjustment
```

The source is scoped to NFL `SEASON` + `REG_SEASON` player totals. Game props, playoff-inclusive futures, combined-stat markets that cannot be allocated safely, suspended quotes, malformed prices, and implausible totals are excluded from consensus. The provider documents season scoping, cursor pagination, normalized player fields, and book-level prices in its [developer manual](https://sportwizzard.com/developers).

### What the model derives

- **Consensus line:** median after reducing each sportsbook to one current vote. A book cannot gain extra influence by returning duplicate lines.
- **Book range and IQR:** fast measures of disagreement. Wide disagreement is information—it often flags role or health uncertainty—so the model exposes it instead of averaging it away.
- **No-vig price lean:** over and under American prices are paired within player + market + book + line, converted to implied probabilities, normalized, and then summarized across books.
- **Movement:** change from the preceding complete snapshot and the closest snapshot at least 24 hours old.
- **Evidence quality (0–100):** up to 45 points for independent-book breadth, 15 for paired O/U prices, 20 for quote freshness across both newest and oldest books, and 20 for cross-book agreement.
- **Vegas-adjusted fantasy points:** begins with the ESPN Mike Clay projection and replaces only stat components supported by current live markets. Missing prop categories retain the projection; they never become zero.

Orange means a current, multi-book quote. Orange-underlined total points are a mixed Vegas/projection result. Blue `A` is the older aggregate snapshot without book-level proof. Gray `~` is projection-only. A cue such as `4b·12m` means four books and a 12-minute-old complete snapshot. Tooltips show the consensus range, IQR, prices, no-vig lean, movement, projection delta, book list, evidence rating, and book age.

Live markets may influence the draft recommendation only when at least two supported stat components are present, at least two books report, average quality is at least 55, and every contributing market passes the freshness check. A failed, incomplete, thin, or stale refresh cannot replace the last good snapshot.

## Reliability and privacy

- Raw tables use RLS and are unavailable to browser clients. The public Edge Function returns only derived consensus rows.
- The sportsbook API key, Supabase secret, and ingestion trigger secret stay in Edge Function/Vault secrets. No secret is embedded in the static site.
- A partial unique index prevents overlapping refreshes; abandoned runs recover automatically.
- Pagination loops, 429/5xx retries, content-type validation, minimum coverage gates, and a hard page ceiling prevent silent truncation.
- Health metadata reports freshness and consecutive failures without exposing internal error details publicly.
- Old snapshots are pruned after 120 days while retaining at least 50 successful runs per season.
- CAG mode hides the private rank/source presentation and substitutes deterministic joke ranks while leaving public projections and Vegas evidence usable.

## Supabase layout

- `supabase/migrations/202609020001_multi_book_vegas.sql` — tables, RLS, history/current consensus, evidence scoring, health, and retention.
- `supabase/functions/ingest-vegas` — authenticated scheduled ingestion and snapshot coverage gates.
- `supabase/functions/vegas-consensus` — CORS-restricted, cached, paginated public consensus API.
- `supabase/setup-vegas-schedule.sql` — hourly refresh and daily retention schedules using `pg_cron`, `pg_net`, and Vault. A full SportWizzard season pull currently spans six billable pages, so hourly polling stays within the 5,000-credit free tier with room for controlled manual refreshes.
- `tests/vegas_parser.test.ts` — market classification, event/season separation, O/U pairing, malformed-data rejection, suspension handling, and name normalization.

## Deployment checklist

1. Link the CLI to project `lodxwbklcvfwkgqyvuha`, then push the migration.
2. Deploy `ingest-vegas` and `vegas-consensus` with JWT verification disabled as specified in `supabase/config.toml`.
3. Store `SPORTWIZZARD_API_KEY` and a long random `VEGAS_INGEST_SECRET` as Edge Function secrets. Optional guard/timeout variables are listed in `supabase/functions/.env.example`.
4. Put the same ingestion secret into `supabase/setup-vegas-schedule.sql`, run it once in SQL Editor, and immediately remove the filled local value if it was saved.
5. Invoke one manual ingestion, verify `vegas_pipeline_health`, then load the public API and the draft room.

Supabase documents [scheduled Edge Functions with Cron, pg_net, and Vault](https://supabase.com/docs/guides/functions/schedule-functions), [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets), and [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Local checks

```powershell
node --experimental-strip-types --test tests/vegas_parser.test.ts
```

The browser regression covers 200 default players, Yahoo and ESPN projections, all remaining snake-pick markers, fast tooltips, CAG privacy, history/undo/restart/stars, sorting, mobile recommendation scrolling, and horizontal table scrolling.
