-- NWO Sip Boyz site: shaping layer.
--
-- scripts/shape.mjs loads every CSV in data/raw/ as a table named after the tab
-- (lowercase, underscores: "Team Weeks" -> team_weeks), runs this file, then reads the
-- out_* views below and writes one JSON file per page into src/generated/.
--
-- Rules carried over from the metrics spec:
--   * consolation games never count toward W-L or head-to-head records
--   * every raw number compared across seasons gets a season-relative partner

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE MACRO slug(s) AS trim(regexp_replace(lower(trim(coalesce(s, ''))), '[^a-z0-9]+', '-', 'g'), '-');
CREATE OR REPLACE MACRO pos_norm(p) AS CASE WHEN p IN ('D/ST', 'DST', 'DEF') THEN 'DEF' ELSE p END;
CREATE OR REPLACE MACRO game_type(is_playoff, tier) AS
  CASE WHEN NOT coalesce(is_playoff, false) THEN 'regular' WHEN tier = 'WINNERS_BRACKET' THEN 'winners' ELSE 'consolation' END;

-- Which positions may fill which lineup slot (ESPN and Sleeper slot names).
CREATE OR REPLACE TABLE slot_elig (slot VARCHAR, pos VARCHAR);
INSERT INTO slot_elig VALUES
  ('QB','QB'),('RB','RB'),('WR','WR'),('TE','TE'),('K','K'),('DEF','DEF'),('D/ST','DEF'),
  ('FLEX','RB'),('FLEX','WR'),('FLEX','TE'),('RB/WR/TE','RB'),('RB/WR/TE','WR'),('RB/WR/TE','TE'),
  ('RB/WR','RB'),('RB/WR','WR'),('WRRB_FLEX','RB'),('WRRB_FLEX','WR'),
  ('WR/TE','WR'),('WR/TE','TE'),('REC_FLEX','WR'),('REC_FLEX','TE'),
  ('SUPER_FLEX','QB'),('SUPER_FLEX','RB'),('SUPER_FLEX','WR'),('SUPER_FLEX','TE'),
  ('OP','QB'),('OP','RB'),('OP','WR'),('OP','TE');

-- ---------------------------------------------------------------- people
-- One row per person. Owner Map may carry an optional `slug` column to pin URLs; otherwise
-- the slug comes from the person's name.
CREATE OR REPLACE VIEW people AS
SELECT person, slug(person) AS slug
FROM (SELECT DISTINCT person FROM owner_map WHERE coalesce(person, '') <> '');

-- Latest avatar and team name per person.
CREATE OR REPLACE VIEW person_latest AS
SELECT person,
       arg_max(team_name, season) AS team_name,
       arg_max(nullif(avatar_url, ''), CASE WHEN coalesce(avatar_url, '') <> '' THEN season END) AS avatar_url
FROM owners WHERE coalesce(person, '') <> ''
GROUP BY person;

-- ---------------------------------------------------------------- seasons
CREATE OR REPLACE VIEW season_last_week AS
SELECT season, max(week) AS last_week,
       max(week) FILTER (WHERE NOT coalesce(is_playoff, false)) AS last_regular_week
FROM matchups GROUP BY season;

CREATE OR REPLACE VIEW out_seasons AS
SELECT s.season, s.platform, s.num_teams, s.regular_season_weeks, s.playoff_teams,
       coalesce(s.champion, '') <> '' AS complete,
       s.champion, s.champion_team, s.runner_up, s.runner_up_team,
       w.last_week, w.last_regular_week,
       (SELECT person FROM team_seasons t WHERE t.season = s.season AND t.last_place) AS last_place,
       (SELECT arg_max(person, points_for) FROM team_seasons t WHERE t.season = s.season) AS points_leader,
       (SELECT max(points_for) FROM team_seasons t WHERE t.season = s.season) AS points_leader_pf,
       (SELECT arg_max(person, wins * 10000 + points_for) FROM team_seasons t WHERE t.season = s.season) AS regular_leader
FROM seasons s LEFT JOIN season_last_week w USING (season)
ORDER BY s.season;

-- Settings that changed from the previous season on the same platform.
CREATE OR REPLACE VIEW out_settings_changes AS
SELECT cur.season, cur.category, cur.setting, prev.value AS before, cur.value AS after
FROM settings cur
JOIN settings prev
  ON prev.platform = cur.platform AND prev.season = cur.season - 1
 AND prev.category = cur.category AND prev.setting = cur.setting
WHERE cur.category IN ('general', 'roster', 'scoring', 'waivers', 'trades', 'draft')
  AND coalesce(CAST(cur.value AS VARCHAR), '') <> coalesce(CAST(prev.value AS VARCHAR), '')
ORDER BY cur.season, cur.category, cur.setting;

-- ---------------------------------------------------------------- standings / season tiles
CREATE OR REPLACE VIEW out_team_seasons AS
SELECT t.*,
       p.slug,
       o.avatar_url,
       round(t.points_for / avg(t.points_for) OVER (PARTITION BY t.season) * 100, 1) AS pf_idx,
       rank() OVER (PARTITION BY t.season ORDER BY t.points_for DESC) AS pf_rank,
       row_number() OVER (PARTITION BY t.season ORDER BY t.wins + 0.5 * t.ties DESC, t.points_for DESC) AS record_rank,
       rank() OVER (PARTITION BY t.season ORDER BY t.QB_vs_avg_pw DESC)  AS rk_QB,
       rank() OVER (PARTITION BY t.season ORDER BY t.RB_vs_avg_pw DESC)  AS rk_RB,
       rank() OVER (PARTITION BY t.season ORDER BY t.WR_vs_avg_pw DESC)  AS rk_WR,
       rank() OVER (PARTITION BY t.season ORDER BY t.TE_vs_avg_pw DESC)  AS rk_TE,
       rank() OVER (PARTITION BY t.season ORDER BY t.K_vs_avg_pw DESC)   AS rk_K,
       rank() OVER (PARTITION BY t.season ORDER BY t.DEF_vs_avg_pw DESC) AS rk_DEF,
       l.text AS summary
FROM team_seasons t
LEFT JOIN people p USING (person)
LEFT JOIN owners o ON o.season = t.season AND o.team_id = t.team_id
LEFT JOIN lore l ON l.season = t.season AND l.category = 'summary' AND l.person = t.person;

-- Weekly league-relative score per team (regular season), for sparklines.
CREATE OR REPLACE VIEW out_sparks AS
SELECT season, team_id, list(rel_score ORDER BY week) AS rel
FROM team_weeks WHERE game_type = 'regular'
GROUP BY season, team_id;

-- ---------------------------------------------------------------- games
-- One row per team per game, with the derived metrics from Team Weeks.
CREATE OR REPLACE VIEW game_sides AS
SELECT m.season, m.platform, m.week, game_type(m.is_playoff, m.playoff_tier) AS game_type,
       m.person, m.team_name, m.team_id, m.points, m.opp_person, m.opp_team_id, m.opp_points, m.result, m.margin,
       slug(least(coalesce(nullif(m.person, ''), 'team-' || m.team_id), coalesce(nullif(m.opp_person, ''), 'team-' || m.opp_team_id)))
         || '-vs-' ||
       slug(greatest(coalesce(nullif(m.person, ''), 'team-' || m.team_id), coalesce(nullif(m.opp_person, ''), 'team-' || m.opp_team_id)))
         AS game_slug,
       tw.optimal_points, tw.bench_lost, tw.efficiency, tw.league_median, tw.rel_score, tw.opp_season_avg, tw.opp_luck
FROM matchups m
LEFT JOIN team_weeks tw
  ON tw.season = m.season AND tw.week = m.week AND tw.team_id = m.team_id;

CREATE OR REPLACE VIEW out_games AS SELECT * FROM game_sides ORDER BY season, week, game_slug, person;

-- ---------------------------------------------------------------- box scores
-- NFL-week lineup rows tagged with the game they counted toward.
CREATE OR REPLACE VIEW lineup_rows AS
SELECT l.rowid AS ord, l.season, l.platform, l.week AS nfl_week, coalesce(l.matchup_week, l.week) AS week,
       l.team_id, l.person, l.slot, l.is_starter, l.player_id, l.player_name, pos_norm(l.position) AS pos, l.nfl_team,
       l.points, gs.game_type
FROM lineups l
LEFT JOIN game_sides gs ON gs.season = l.season AND gs.week = coalesce(l.matchup_week, l.week) AND gs.team_id = l.team_id;

-- A player's season average: NFL games played (nflverse, league-scored) when available,
-- otherwise his league points in weeks he scored (team defenses).
CREATE OR REPLACE VIEW player_avg AS
WITH weekly AS (
  SELECT season, platform, player_id, nfl_week, max(points) AS points
  FROM lineup_rows WHERE coalesce(player_id, '') <> ''
  GROUP BY ALL
)
SELECT w.season, w.platform, w.player_id,
       coalesce(max(n.ppg), avg(w.points) FILTER (WHERE w.points <> 0)) AS avg_pts
FROM weekly w
LEFT JOIN nfl_seasons n
  ON n.season = w.season
 AND ((w.platform = 'ESPN' AND n.espn_id = w.player_id) OR (w.platform = 'Sleeper' AND n.sleeper_id = w.player_id))
GROUP BY ALL;

-- Average started points at each position in the regular season.
CREATE OR REPLACE VIEW slot_avg AS
SELECT season, pos, avg(points) AS avg_pts
FROM lineup_rows WHERE is_starter AND game_type = 'regular'
GROUP BY ALL;

-- Box score rows: one per player per game (two-week playoff rounds summed).
CREATE OR REPLACE VIEW out_box AS
SELECT season, week, team_id, person, slot, is_starter, player_id, player_name, pos, nfl_team,
       round(sum(points), 2) AS points,
       count(DISTINCT nfl_week) AS nfl_weeks,
       round(any_value(pa.avg_pts) * count(DISTINCT nfl_week), 2) AS player_avg,
       round(any_value(sa.avg_pts) * count(DISTINCT nfl_week), 2) AS pos_avg,
       min(ord) AS ord
FROM lineup_rows lr
LEFT JOIN player_avg pa USING (season, platform, player_id)
LEFT JOIN slot_avg sa USING (season, pos)
WHERE slot <> 'IR'
GROUP BY season, week, team_id, person, slot, is_starter, player_id, player_name, pos, nfl_team
ORDER BY season, week, team_id, is_starter DESC, ord;

-- Worst start/sit call per team-game: the biggest gap between a benched player and a
-- starter he could legally have replaced that NFL week.
CREATE OR REPLACE VIEW out_calls AS
WITH pairs AS (
  SELECT s.season, s.week, s.team_id, s.person, s.game_type,
         b.player_name AS benched, b.points AS benched_pts,
         s.player_name AS started, s.points AS started_pts,
         round(b.points - s.points, 2) AS cost
  FROM lineup_rows s
  JOIN slot_elig e ON e.slot = s.slot
  JOIN lineup_rows b
    ON b.season = s.season AND b.nfl_week = s.nfl_week AND b.team_id = s.team_id
   AND NOT b.is_starter AND b.slot <> 'IR' AND b.pos = e.pos
  WHERE s.is_starter AND b.points > s.points
)
SELECT season, week, team_id, person, game_type,
       arg_max(benched, cost) AS benched, arg_max(benched_pts, cost) AS benched_pts,
       arg_max(started, cost) AS started, arg_max(started_pts, cost) AS started_pts, max(cost) AS cost
FROM pairs GROUP BY ALL;

-- ---------------------------------------------------------------- season modules
CREATE OR REPLACE VIEW out_weeks AS
SELECT season, week, any_value(game_type) FILTER (WHERE game_type <> 'consolation') AS game_type,
       max(league_median) AS median, max(points) AS high, min(points) AS low, count(*) // 2 AS games
FROM game_sides GROUP BY ALL ORDER BY season, week;

CREATE OR REPLACE VIEW out_awards AS
WITH g AS (SELECT * FROM game_sides WHERE game_type <> 'consolation')
SELECT season, 'High score' AS award, arg_max(person, points) AS person,
       max(points) AS value, arg_max(week, points) AS week, arg_max(game_slug, points) AS game_slug FROM g GROUP BY season
UNION ALL
SELECT season, 'Low score', arg_min(person, points), min(points), arg_min(week, points), arg_min(game_slug, points) FROM g GROUP BY season
UNION ALL
SELECT season, 'Biggest blowout', arg_max(person || ' d. ' || opp_person, margin), max(margin), arg_max(week, margin), arg_max(game_slug, margin)
FROM g WHERE result = 'W' GROUP BY season
UNION ALL
SELECT season, 'Closest game', arg_min(person || ' d. ' || opp_person, margin), min(margin), arg_min(week, margin), arg_min(game_slug, margin)
FROM g WHERE result = 'W' GROUP BY season
UNION ALL
SELECT c.season, 'Worst start/sit', arg_max(c.person || ': ' || c.started || ' over ' || c.benched, c.cost), max(c.cost),
       arg_max(c.week, c.cost), arg_max(gs.game_slug, c.cost)
FROM out_calls c JOIN game_sides gs USING (season, week, team_id)
WHERE c.game_type <> 'consolation' GROUP BY c.season
UNION ALL
SELECT season, 'Best pickup', arg_max(person || ': ' || player_name, sp), max(sp), NULL, NULL
FROM player_seasons WHERE acquired_via IN ('waiver', 'free_agent') GROUP BY season
UNION ALL
SELECT season, 'Best trade', arg_max(person || ' (' || coalesce(received, '') || ')', margin), max(margin), arg_max(week, margin), NULL
FROM trade_ledger WHERE result = 'won' GROUP BY season;

CREATE OR REPLACE VIEW out_trades AS
SELECT season, week, date, transaction_id, person, counterparty, received, sent, picks_received, picks_sent,
       sp_received, sp_sent, margin, result
FROM trade_ledger ORDER BY season, week, transaction_id, margin DESC;

-- Draft board: each pick with its grade and the team's column (its round-1 slot).
CREATE OR REPLACE VIEW out_draft AS
WITH slot AS (
  SELECT season, team_id, min(round_pick) FILTER (WHERE round = 1) AS col FROM drafts GROUP BY ALL
)
SELECT d.season, d.round, d.overall, d.round_pick, d.person, d.team_id, s.col,
       d.player_name, pos_norm(d.position) AS pos, d.is_keeper,
       g.grade, g.pos_rank, g.vor, g.value_over_slot, g.sp_for_team
FROM drafts d
LEFT JOIN slot s USING (season, team_id)
LEFT JOIN draft_grades g ON g.season = d.season AND g.overall = d.overall
ORDER BY d.season, d.overall;

CREATE OR REPLACE VIEW out_lore AS
SELECT season, category, person, title, text, source, status FROM lore ORDER BY season, category, person;

-- ---------------------------------------------------------------- owners
-- Percentile vs. owners with 3+ seasons (spec minimum), 0-100, higher = better.
CREATE OR REPLACE VIEW out_careers AS
WITH ranked AS (
  SELECT c.*, p.slug, pl.team_name AS latest_team, pl.avatar_url,
         CASE WHEN c.seasons >= 3 THEN round(100 * percent_rank() OVER (PARTITION BY c.seasons >= 3 ORDER BY c.titles * 10 + c.win_pct)) END AS pct_winning,
         CASE WHEN c.seasons >= 3 THEN round(100 * percent_rank() OVER (PARTITION BY c.seasons >= 3 ORDER BY c.trade_margin)) END AS pct_trading,
         CASE WHEN c.seasons >= 3 THEN round(100 * percent_rank() OVER (PARTITION BY c.seasons >= 3 ORDER BY c.draft_vos_per_season)) END AS pct_drafting,
         CASE WHEN c.seasons >= 3 THEN round(100 * percent_rank() OVER (PARTITION BY c.seasons >= 3 ORDER BY c.efficiency)) END AS pct_lineups,
         CASE WHEN c.seasons >= 3 THEN round(100 * percent_rank() OVER (PARTITION BY c.seasons >= 3 ORDER BY c.waiver_sp_per_season)) END AS pct_acquiring,
         CASE WHEN c.seasons >= 3 THEN round(100 * percent_rank() OVER (PARTITION BY c.seasons >= 3 ORDER BY c.career_luck)) END AS pct_luck
  FROM careers c
  LEFT JOIN people p USING (person)
  LEFT JOIN person_latest pl USING (person)
),
finishes AS (
  SELECT person,
         min(final_rank) AS best_finish, arg_min(season, final_rank) AS best_finish_season,
         max(final_rank) AS worst_finish, arg_max(season, final_rank) AS worst_finish_season
  FROM team_seasons WHERE final_rank IS NOT NULL GROUP BY person
)
SELECT r.*, f.best_finish, f.best_finish_season, f.worst_finish, f.worst_finish_season,
       rank() OVER (ORDER BY r.win_pct DESC) AS win_pct_rank,
       rank() OVER (ORDER BY r.allplay_pct DESC) AS allplay_rank,
       count(*) OVER () AS owners
FROM ranked r LEFT JOIN finishes f USING (person)
ORDER BY r.titles DESC, r.win_pct DESC;

-- Head-to-head, regular season + winners bracket only.
CREATE OR REPLACE VIEW out_h2h AS
SELECT person, opp_person, count(*) AS games,
       count(*) FILTER (WHERE result = 'W') AS w, count(*) FILTER (WHERE result = 'L') AS l, count(*) FILTER (WHERE result = 'T') AS t,
       round(avg(points), 1) AS pf_g, round(avg(opp_points), 1) AS pa_g,
       count(*) FILTER (WHERE game_type = 'winners' AND result = 'W') AS po_w,
       count(*) FILTER (WHERE game_type = 'winners' AND result = 'L') AS po_l,
       arg_max(season, season * 100 + week) AS last_season, arg_max(week, season * 100 + week) AS last_week,
       arg_max(game_slug, season * 100 + week) AS last_slug
FROM game_sides
WHERE game_type <> 'consolation' AND coalesce(person, '') <> '' AND coalesce(opp_person, '') <> ''
GROUP BY person, opp_person;

-- Players who scored the most started points for each owner, across seasons and platforms.
CREATE OR REPLACE VIEW out_signature AS
WITH by_player AS (
  SELECT person, any_value(player_name) AS player_name, any_value(position) AS pos,
         sum(sp) AS sp, sum(starts) AS starts, min(season) AS first_season, max(season) AS last_season,
         count(DISTINCT season) AS seasons, arg_max(season, sp) AS best_season, max(sp) AS best_sp
  FROM player_seasons WHERE coalesce(person, '') <> ''
  GROUP BY person, lower(player_name)
)
SELECT * FROM by_player
QUALIFY row_number() OVER (PARTITION BY person ORDER BY sp DESC) <= 8
ORDER BY person, sp DESC;

CREATE OR REPLACE VIEW out_pickups AS
SELECT person, season, player_name, position AS pos, acquired_via, acquired_week, starts, sp
FROM player_seasons
WHERE acquired_via IN ('waiver', 'free_agent') AND coalesce(person, '') <> ''
QUALIFY row_number() OVER (PARTITION BY person ORDER BY sp DESC) <= 6
ORDER BY person, sp DESC;
