// Turns data/raw/*.csv (the Sheet export) into the JSON the pages read, via DuckDB.
//
//   data/raw/<tab>.csv  →  table <tab>  →  sql/views.sql (out_* views)  →  src/generated/*.json
//
// DATA_DIR overrides the input folder (handy for testing with other CSVs).

import { readdir, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';

const root = new URL('../', import.meta.url);
const DATA_DIR = process.env.DATA_DIR ? new URL(process.env.DATA_DIR.replace(/\/?$/, '/'), 'file://' + process.cwd() + '/') : new URL('data/raw/', root);
const OUT = new URL('src/generated/', root);

const db = await (await DuckDBInstance.create(':memory:')).connect();
const run = (sql) => db.run(sql);
const rows = async (sql) => (await db.runAndReadAll(sql)).getRowObjectsJS().map(clean);

// DuckDB hands back BigInt for integers and lists as arrays; make everything JSON-friendly.
function clean(v) {
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = clean(x);
    return o;
  }
  return v;
}

/* ------------------------------------------------------------ load CSVs */
const files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.csv'));
if (!files.length) throw new Error(`No CSVs in ${DATA_DIR.pathname}. Run "npm run export" first.`);
const tables = new Set();
for (const f of files) {
  const table = f.replace(/\.csv$/, '').replace(/-/g, '_');
  const path = new URL(f, DATA_DIR).pathname;
  const header = (await readFile(path, 'utf8')).split('\n', 1)[0].split(',');
  // IDs stay text: Sleeper IDs overflow doubles, ESPN owner IDs are GUIDs.
  const ids = header.filter((c) => /_id$/.test(c)).map((c) => `'${c}': 'VARCHAR'`);
  const types = ids.length ? `, types = {${ids.join(', ')}}` : '';
  await run(`CREATE TABLE "${table}" AS SELECT * FROM read_csv('${path}', header = true, sample_size = -1,
    nullstr = ''${types})`);
  tables.add(table);
}

// Optional tabs: an empty stand-in keeps the views working before they exist.
const OPTIONAL = {
  lore: 'season INTEGER, category VARCHAR, person VARCHAR, title VARCHAR, text VARCHAR, source VARCHAR, status VARCHAR',
  nfl_seasons: 'season INTEGER, nfl_team VARCHAR, games INTEGER, points DOUBLE, ppg DOUBLE, pos_rank INTEGER, vor DOUBLE, replacement_points DOUBLE, espn_id VARCHAR, sleeper_id VARCHAR',
  draft_grades: 'season INTEGER, overall INTEGER, grade VARCHAR, pos_rank INTEGER, vor DOUBLE, value_over_slot DOUBLE, sp_for_team DOUBLE',
  trade_ledger: 'platform VARCHAR, season INTEGER, week INTEGER, date VARCHAR, person VARCHAR, team_name VARCHAR, counterparty VARCHAR, received VARCHAR, sent VARCHAR, picks_received VARCHAR, picks_sent VARCHAR, sp_received DOUBLE, sp_sent DOUBLE, margin DOUBLE, result VARCHAR, transaction_id VARCHAR',
  settings: 'platform VARCHAR, season INTEGER, category VARCHAR, setting VARCHAR, value VARCHAR, detail VARCHAR',
  transactions: 'season INTEGER, type VARCHAR, action VARCHAR, person VARCHAR, faab_bid DOUBLE',
};
for (const [t, cols] of Object.entries(OPTIONAL)) if (!tables.has(t)) await run(`CREATE TABLE ${t} (${cols})`);

await run(await readFile(new URL('sql/views.sql', root), 'utf8'));

/* ------------------------------------------------------------ read views */
const [seasons, changes, teamSeasons, sparks, games, box, calls, weeks, awards, trades, draft, lore,
  careers, h2h, signature, pickups, power] = await Promise.all([
  'out_seasons', 'out_settings_changes', 'out_team_seasons', 'out_sparks', 'out_games', 'out_box', 'out_calls',
  'out_weeks', 'out_awards', 'out_trades', 'out_draft', 'out_lore', 'out_careers', 'out_h2h', 'out_signature', 'out_pickups',
  'out_power',
].map((v) => rows(`SELECT * FROM ${v}`)));

const slugOf = Object.fromEntries((await rows('SELECT person, slug FROM people')).map((p) => [p.person, p.slug]));
const by = (xs, key) => xs.reduce((m, x) => ((m[key(x)] ||= []).push(x), m), {});
const r1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const lorePick = (season, category, person) => lore.find((l) => l.season === season && l.category === category && (!person || l.person === person));
const exportedAt = await readFile(new URL('_manifest.json', DATA_DIR), 'utf8').then((t) => JSON.parse(t).exported_at).catch(() => null);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const write = (name, obj) => writeFile(new URL(name, OUT), JSON.stringify(obj));

// Readable names for ESPN scoring stat IDs (the loader names the common ones already).
const ESPN_STATS = { 17: '300-399 pass yd bonus', 18: '400+ pass yd bonus', 19: 'passing 2-pt', 26: 'rushing 2-pt',
  37: '100-199 rush yd bonus', 38: '200+ rush yd bonus', 44: 'receiving 2-pt', 56: '100-199 rec yd bonus',
  57: '200+ rec yd bonus', 63: 'fumble recovery TD', 74: '50+ yd FG', 77: '40-49 yd FG', 80: '0-39 yd FG',
  85: 'missed FG', 86: 'PAT made', 88: 'PAT missed', 101: 'kick/punt return TD', 198: '50-59 yd FG', 201: '60+ yd FG' };
const SETTING_NAMES = { FLEX: 'FLEX slots', BN: 'bench slots', regular_season_weeks: 'regular-season weeks',
  waiver_type: 'waiver type (0 rolling, 1 reverse standings, 2 FAAB)', fgmiss: 'missed FG', faab_budget: 'FAAB budget' };
function settingName(k) {
  const m = /^statId (\d+)$/.exec(k);
  return m ? (ESPN_STATS[m[1]] || k) : (SETTING_NAMES[k] || k.replace(/_/g, ' '));
}

/* ------------------------------------------------------------ seasons */
const tsBySeason = by(teamSeasons, (t) => t.season);
const sparkKey = Object.fromEntries(sparks.map((s) => [`${s.season}|${s.team_id}`, s.rel.map(r1)]));
const gamesBySeason = by(games, (g) => g.season);
const boxByGame = by(box, (b) => `${b.season}|${b.week}|${b.team_id}`);
const callByGame = Object.fromEntries(calls.map((c) => [`${c.season}|${c.week}|${c.team_id}`, c]));

const sideOut = (g) => ({
  person: g.person, slug: slugOf[g.person] || null, team: g.team_name, team_id: g.team_id,
  points: r2(g.points), result: g.result, optimal: r2(g.optimal_points), bench_lost: r2(g.bench_lost),
  efficiency: g.efficiency, rel: r1(g.rel_score), opp_luck: r2(g.opp_luck), opp_avg: r2(g.opp_season_avg),
});
// Pair the two sides of each game, winner first.
function pairGames(rowsForWeek) {
  return Object.values(by(rowsForWeek, (g) => g.game_slug)).map((pair) => {
    const sides = pair.sort((a, b) => b.points - a.points).map(sideOut);
    const g = pair[0];
    return { slug: g.game_slug, week: g.week, game_type: g.game_type, margin: r2(Math.abs(pair[0].margin)), sides };
  });
}

const seasonList = [];
for (const s of seasons) {
  const ts = tsBySeason[s.season] || [];
  const order = s.complete ? (t) => t.final_rank ?? 99 : (t) => t.record_rank;
  const standings = ts.slice().sort((a, b) => order(a) - order(b)).map((t) => ({
    person: t.person, slug: t.slug, team: t.team_name, avatar: t.avatar_url || null,
    seed: t.playoff_seed, final_rank: t.final_rank, rank: s.complete ? t.final_rank : t.record_rank,
    wins: t.wins, losses: t.losses, ties: t.ties, pf: r2(t.points_for), pa: r2(t.points_against), pf_idx: t.pf_idx, pf_rank: t.pf_rank,
    allplay_w: t.allplay_w, allplay_l: t.allplay_l, allplay_pct: t.allplay_pct, xw: t.expected_wins, luck: t.luck,
    efficiency: t.efficiency, bench_lost: t.bench_lost_per_week, made_playoffs: t.made_playoffs,
    champion: t.champion, runner_up: t.runner_up, last_place: t.last_place,
    sources: { draft: (t.sp_draft || 0) + (t.sp_keeper || 0), waiver: t.sp_waiver || 0, free_agent: t.sp_free_agent || 0, trade: t.sp_trade || 0 },
    pos_rank: { QB: t.rk_QB, RB: t.rk_RB, WR: t.rk_WR, TE: t.rk_TE, K: t.rk_K, DEF: t.rk_DEF },
    pos_vs_avg: { QB: t.QB_vs_avg_pw, RB: t.RB_vs_avg_pw, WR: t.WR_vs_avg_pw, TE: t.TE_vs_avg_pw, K: t.K_vs_avg_pw, DEF: t.DEF_vs_avg_pw },
    summary: t.summary || null,
  }));

  const seasonGames = gamesBySeason[s.season] || [];
  const byWeek = by(seasonGames, (g) => g.week);
  const weekList = weeks.filter((w) => w.season === s.season).map((w) => ({
    week: w.week, game_type: w.game_type || 'consolation', median: r2(w.median), high: r2(w.high), low: r2(w.low),
  }));
  const bracket = Object.keys(byWeek).map(Number).sort((a, b) => a - b)
    .map((w) => ({ week: w, games: pairGames(byWeek[w].filter((g) => g.game_type === 'winners')) }))
    .filter((r) => r.games.length);

  const recap = lorePick(s.season, 'recap');
  const punishment = s.last_place ? lorePick(s.season, 'punishment', s.last_place) : null;
  const leaderRow = ts.find((t) => t.person === s.points_leader);
  const prevPlatform = seasons.find((x) => x.season === s.season - 1)?.platform;

  const season = {
    season: s.season, platform: s.platform, complete: s.complete, num_teams: s.num_teams,
    regular_season_weeks: s.regular_season_weeks, playoff_teams: s.playoff_teams, last_week: s.last_week,
    champion: s.champion ? { person: s.champion, slug: slugOf[s.champion], team: s.champion_team } : null,
    runner_up: s.runner_up ? { person: s.runner_up, slug: slugOf[s.runner_up], team: s.runner_up_team } : null,
    regular_leader: s.regular_leader ? { person: s.regular_leader, slug: slugOf[s.regular_leader] } : null,
    points_leader: leaderRow ? { person: leaderRow.person, slug: leaderRow.slug, pf: r2(leaderRow.points_for), idx: leaderRow.pf_idx } : null,
    last_place: s.last_place && s.complete ? { person: s.last_place, slug: slugOf[s.last_place], punishment: punishment?.text || null } : null,
    recap: recap ? { title: recap.title, text: recap.text, status: recap.status } : null,
    platform_switch: prevPlatform && prevPlatform !== s.platform ? prevPlatform : null,
    changes: changes.filter((c) => c.season === s.season).slice(0, 6).map((c) => ({ ...c, setting: settingName(c.setting) })),
    standings, weeks: weekList, bracket,
    // One line per team, in standings order: weekly score vs. median and its 3-week rolling average.
    power: standings.map((r) => {
      const t = ts.find((x) => x.person === r.person);
      return { person: r.person, slug: r.slug, team: r.team,
        points: power.filter((p) => p.season === s.season && p.team_id === t.team_id)
          .map((p) => ({ week: p.week, rel: r1(p.rel_score), roll: r1(p.roll3), rank: p.week_rank })) };
    }),
    awards: awards.filter((a) => a.season === s.season).map((a) => ({ ...a, value: r2(a.value) })),
    trades: Object.values(by(trades.filter((t) => t.season === s.season), (t) => t.transaction_id))
      .map((sides) => ({ week: sides[0].week, date: sides[0].date, sides: sides.sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0)) }))
      .sort((a, b) => (a.week ?? 0) - (b.week ?? 0)),
    draft: draftBoard(draft.filter((d) => d.season === s.season)),
  };
  await write(`season-${s.season}.json`, season);

  // Week scoreboards and box scores for this season.
  const gamesOut = { season: s.season, weeks: {}, boxes: {} };
  for (const w of weekList) {
    const paired = pairGames(byWeek[w.week] || []);
    gamesOut.weeks[w.week] = { ...w, games: paired };
    for (const g of paired) {
      gamesOut.boxes[`${w.week}/${g.slug}`] = {
        ...g,
        median: w.median,
        sides: g.sides.map((side) => {
          const rows = boxByGame[`${s.season}|${w.week}|${side.team_id}`] || [];
          const call = callByGame[`${s.season}|${w.week}|${side.team_id}`];
          const player = (b) => ({ slot: b.slot, name: b.player_name, pos: b.pos, nfl_team: b.nfl_team, points: r2(b.points),
            player_avg: r1(b.player_avg), pos_avg: r1(b.pos_avg) });
          return { ...side,
            starters: rows.filter((b) => b.is_starter).map(player),
            bench: rows.filter((b) => !b.is_starter).sort((a, b) => b.points - a.points).map(player),
            call: call && call.cost > 0 ? { started: call.started, started_pts: r2(call.started_pts), benched: call.benched,
              benched_pts: r2(call.benched_pts), cost: r2(call.cost) } : null };
        }),
      };
    }
  }
  await write(`games-${s.season}.json`, gamesOut);

  seasonList.push({
    season: s.season, platform: s.platform, complete: s.complete, last_week: s.last_week,
    champion: season.champion, runner_up: season.runner_up, last_place: season.last_place,
    points_leader: season.points_leader, recap_title: recap?.title || null,
  });
}

function draftBoard(picks) {
  if (!picks.length) return null;
  const cols = Object.values(by(picks.filter((p) => p.col), (p) => p.col)).map((ps) => ({ col: ps[0].col, person: ps[0].person, slug: slugOf[ps[0].person] }))
    .sort((a, b) => a.col - b.col);
  const rounds = Object.values(by(picks, (p) => p.round)).sort((a, b) => a[0].round - b[0].round).map((ps) =>
    cols.map((c) => {
      const p = ps.find((x) => x.col === c.col);
      return p ? { overall: p.overall, name: p.player_name, pos: p.pos, grade: p.grade || null, pos_rank: p.pos_rank,
        vos: r1(p.value_over_slot), sp: r1(p.sp_for_team), keeper: p.is_keeper } : null;
    }));
  return { cols, rounds };
}

/* ------------------------------------------------------------ owners */
const ownerList = [];
const h2hBy = by(h2h, (r) => r.person);
for (const c of careers) {
  const ts = teamSeasons.filter((t) => t.person === c.person).sort((a, b) => b.season - a.season);
  const sMeta = Object.fromEntries(seasons.map((s) => [s.season, s]));
  const tiles = ts.map((t) => ({
    season: t.season, platform: t.platform, team: t.team_name, avatar: t.avatar_url || null,
    complete: sMeta[t.season]?.complete ?? true, through_week: sMeta[t.season]?.last_week,
    final_rank: t.final_rank, record_rank: t.record_rank, made_playoffs: t.made_playoffs,
    champion: t.champion, runner_up: t.runner_up, last_place: t.last_place, points_leader: t.pf_rank === 1,
    wins: t.wins, losses: t.losses, ties: t.ties, pf_rank: t.pf_rank, luck: t.luck, efficiency: t.efficiency,
    spark: sparkKey[`${t.season}|${t.team_id}`] || [],
    pos_rank: { QB: t.rk_QB, RB: t.rk_RB, WR: t.rk_WR, TE: t.rk_TE, K: t.rk_K, DEF: t.rk_DEF },
    pos_vs_avg: { QB: t.QB_vs_avg_pw, RB: t.RB_vs_avg_pw, WR: t.WR_vs_avg_pw, TE: t.TE_vs_avg_pw, K: t.K_vs_avg_pw, DEF: t.DEF_vs_avg_pw },
    summary: t.summary || null,
  }));
  const owner = {
    person: c.person, slug: c.slug, active: c.active, avatar: c.avatar_url || null, latest_team: c.latest_team,
    career: {
      seasons: c.seasons, first_season: c.first_season, last_season: c.last_season, titles: c.titles, finals: c.finals,
      playoff_apps: c.playoff_apps, last_places: c.last_places, wins: c.wins, losses: c.losses, ties: c.ties,
      win_pct: c.win_pct, win_pct_rank: c.win_pct_rank, allplay_pct: c.allplay_pct, allplay_rank: c.allplay_rank, owners: c.owners,
      luck: c.career_luck, efficiency: c.efficiency, bench_lost: c.bench_lost_per_week,
      best_finish: c.best_finish, best_finish_season: c.best_finish_season, worst_finish: c.worst_finish, worst_finish_season: c.worst_finish_season,
      title_seasons: ts.filter((t) => t.champion).map((t) => t.season).sort(),
      final_seasons: ts.filter((t) => t.champion || t.runner_up).map((t) => t.season).sort(),
      completed_seasons: tiles.filter((t) => t.complete).length,
    },
    profile: c.seasons >= 3 ? [
      { key: 'winning', label: 'Winning', pct: c.pct_winning, metric: `${c.titles} title${c.titles === 1 ? '' : 's'} · ${fmtPct(c.win_pct)} win %` },
      { key: 'drafting', label: 'Drafting', pct: c.pct_drafting, metric: `${signed(c.draft_vos_per_season)} value over slot / season` },
      { key: 'trading', label: 'Trading', pct: c.pct_trading, metric: `${signed(c.trade_margin)} SP margin · ${c.trades_won} of ${c.trades} won` },
      { key: 'acquiring', label: 'Acquiring', pct: c.pct_acquiring, metric: `${c.waiver_sp_per_season} waiver SP / season · ${fmtPct(c.waiver_hit_rate)} hit rate` },
      { key: 'lineups', label: 'Lineup management', pct: c.pct_lineups, metric: `${fmtPct(c.efficiency)} efficiency · ${c.bench_lost_per_week} bench pts / wk` },
      { key: 'luck', label: 'Luck', pct: c.pct_luck, metric: `${signed(c.career_luck)} wins vs. expected` },
    ] : null,
    best_pick: c.best_pick || null,
    tiles,
    rivals: (h2hBy[c.person] || []).sort((a, b) => b.games - a.games || b.w - a.w).map((r) => ({
      opp: r.opp_person, slug: slugOf[r.opp_person], games: r.games, w: r.w, l: r.l, t: r.t, pf_g: r.pf_g, pa_g: r.pa_g,
      po_w: r.po_w, po_l: r.po_l, last: { season: r.last_season, week: r.last_week, slug: r.last_slug } })),
    players: signature.filter((p) => p.person === c.person).map((p) => ({ name: p.player_name, pos: p.pos, sp: r1(p.sp), starts: p.starts,
      first_season: p.first_season, last_season: p.last_season, seasons: p.seasons, per_start: p.starts ? r1(p.sp / p.starts) : null,
      best_season: p.best_season, best_sp: r1(p.best_sp) })),
    pickups: pickups.filter((p) => p.person === c.person).map((p) => ({ ...p, sp: r1(p.sp) })),
    trades: trades.filter((t) => t.person === c.person).sort((a, b) => b.season - a.season || (b.week ?? 0) - (a.week ?? 0)),
    lore: lore.filter((l) => l.person === c.person && ['recap', 'punishment', 'moment', 'belt'].includes(l.category)),
  };
  await write(`owner-${c.slug}.json`, owner);
  ownerList.push({ person: c.person, slug: c.slug, active: c.active, avatar: owner.avatar, latest_team: c.latest_team,
    seasons: c.seasons, first_season: c.first_season, last_season: c.last_season, titles: c.titles, finals: c.finals,
    wins: c.wins, losses: c.losses, ties: c.ties, win_pct: c.win_pct, title_seasons: owner.career.title_seasons });
}

function fmtPct(x) { return x === null || x === undefined ? '—' : Number(x).toFixed(3).replace(/^0/, ''); }
function signed(x) { return x === null || x === undefined ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 1 }); }

// Players: every rostered player-season, compact keys (the page fetches this file).
const players = await rows('SELECT * FROM out_players');
await write('players.json', {
  people: Object.fromEntries(careers.map((c) => [c.person, c.slug])),
  rows: players.map((p) => ({
    s: p.season, id: p.player_id, n: p.player_name, p: p.pos, t: p.nfl_team || null,
    pts: r1(p.points), g: p.games ?? null, ppg: r1(p.ppg), rk: p.pos_rank ?? null, vor: r1(p.vor), rep: r1(p.replacement_points),
    sp: r1(p.sp), st: p.starts,
    o: p.owners.map(([person, sp, starts, via]) => [person, Number(sp), Number(starts), via]),
    d: p.drafted_by ? [p.drafted_by, p.draft_round, p.draft_overall] : null,
  })),
});

// Leaderboards: per owner-season pieces the page re-totals for any range of seasons.
const lbRows = await rows('SELECT * FROM out_lb_seasons');
await write('leaderboards.json', {
  seasons: seasons.map((s) => ({ season: s.season, platform: s.platform, complete: s.complete })),
  people: Object.fromEntries(careers.map((c) => [c.person, { slug: c.slug, active: c.active }])),
  rows: lbRows.map((r) => ({ ...r, luck: r1(r.luck), trade_margin: r2(r.trade_margin), pickup_sp: r1(r.pickup_sp),
    waiver_sp: r1(r.waiver_sp), eff_sum: r.eff_sum === null ? null : Math.round(r.eff_sum * 1000) / 1000,
    bench_sum: r1(r.bench_sum), po_opp_luck: r1(r.po_opp_luck), best_pick_vos: r1(r.best_pick_vos) })),
});
/* ------------------------------------------------------------ owner-season cockpits */
// One file per team-season: game log, roster, draft, moves and the season's rollups.
const playerSeasonRows = await rows('SELECT * FROM player_seasons');
const psByTeam = by(playerSeasonRows, (p) => `${p.season}|${p.team_id}`);
const nflBy = Object.fromEntries(players.map((p) => [`${p.season}|${p.player_id}`, p]));
const gamesByTeam = by(games, (g) => `${g.season}|${g.team_id}`);
const draftByTeam = by(draft, (d) => `${d.season}|${d.team_id}`);
const seasonMeta = Object.fromEntries(seasons.map((s) => [s.season, s]));
for (const t of teamSeasons) {
  if (!t.slug) continue;
  const key = `${t.season}|${t.team_id}`;
  const meta = seasonMeta[t.season] || {};
  const peers = tsBySeason[t.season] || [];
  const avgPf = peers.reduce((a, x) => a + x.points_for, 0) / (peers.length || 1);
  const log = (gamesByTeam[key] || []).sort((a, b) => a.week - b.week).map((g) => {
    const call = callByGame[`${g.season}|${g.week}|${g.team_id}`];
    return { week: g.week, game_type: g.game_type, slug: g.game_slug, opp: g.opp_person, opp_slug: slugOf[g.opp_person] || null,
      result: g.result, points: r2(g.points), opp_points: r2(g.opp_points), margin: r2(g.margin),
      rel: r1(g.rel_score), median: r2(g.league_median), optimal: r2(g.optimal_points), bench_lost: r2(g.bench_lost),
      efficiency: g.efficiency, opp_luck: r2(g.opp_luck), opp_avg: r2(g.opp_season_avg),
      call: call && call.cost > 0 ? { started: call.started, benched: call.benched, cost: r2(call.cost) } : null };
  });
  // Running record through the regular season.
  let w = 0, l = 0, tt = 0;
  for (const g of log) {
    if (g.game_type !== 'regular') { g.record = null; continue; }
    if (g.result === 'W') w++; else if (g.result === 'L') l++; else tt++;
    g.record = `${w}-${l}${tt ? '-' + tt : ''}`;
  }
  const roster = (psByTeam[key] || []).map((p) => {
    const n = nflBy[`${p.season}|${p.player_id}`] || {};
    return { name: p.player_name, pos: p.position, via: p.acquired_via, via_week: p.acquired_week || null,
      draft_round: p.draft_round || null, draft_overall: p.draft_overall || null, first_week: p.first_week,
      weeks: p.weeks_rostered, starts: p.starts, sp: r1(p.sp), sp_regular: r1(p.sp_regular), bench: r1(p.bench_points),
      nfl_team: n.nfl_team || null, finish: n.pos_rank ? `${p.position}${n.pos_rank}` : null, vor: r1(n.vor), pts: r1(n.points) };
  }).sort((a, b) => b.sp - a.sp || b.weeks - a.weeks);
  // Lineup grid: player × week, started or benched, with points (two-week rounds already summed).
  const boxRows = Object.keys(boxByGame).filter((k) => k.startsWith(`${t.season}|`) && k.endsWith(`|${t.team_id}`))
    .flatMap((k) => boxByGame[k])
    .filter((b) => log.some((g) => g.week === b.week)); // only weeks the team actually played
  const gridWeeks = [...new Set(boxRows.map((b) => b.week))].sort((a, b) => a - b);
  const gridPlayers = Object.values(by(boxRows, (b) => b.player_name)).map((rs) => ({
    name: rs[0].player_name, pos: rs[0].pos,
    weeks: Object.fromEntries(rs.map((b) => [b.week, [b.is_starter ? 1 : 0, r1(b.points)]])),
    starts: rs.filter((b) => b.is_starter).length, sp: rs.filter((b) => b.is_starter).reduce((a, b) => a + b.points, 0),
  })).sort((a, b) => b.starts - a.starts || b.sp - a.sp);
  const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DEF: 5 };
  gridPlayers.sort((a, b) => (POS_ORDER[a.pos] ?? 9) - (POS_ORDER[b.pos] ?? 9) || b.starts - a.starts || b.sp - a.sp);
  const grid = { weeks: gridWeeks, players: gridPlayers.map(({ sp, ...rest }) => rest) };
  const seasonsOfOwner = teamSeasons.filter((x) => x.person === t.person).map((x) => x.season).sort((a, b) => a - b);
  await write(`os-${t.slug}-${t.season}.json`, {
    person: t.person, slug: t.slug, season: t.season, platform: t.platform, team: t.team_name, avatar: t.avatar_url || null,
    complete: meta.complete ?? true, through_week: meta.last_week, regular_season_weeks: meta.regular_season_weeks,
    num_teams: meta.num_teams, playoff_teams: meta.playoff_teams,
    prev: seasonsOfOwner.filter((y) => y < t.season).pop() ?? null, next: seasonsOfOwner.find((y) => y > t.season) ?? null,
    summary: t.summary || null,
    recap: (() => { const r = lorePick(t.season, 'recap', t.person); return r ? { title: r.title, text: r.text, status: r.status } : null; })(),
    punishment: t.last_place ? (lorePick(t.season, 'punishment', t.person)?.text || null) : null,
    stats: {
      wins: t.wins, losses: t.losses, ties: t.ties, final_rank: t.final_rank, record_rank: t.record_rank, seed: t.playoff_seed,
      made_playoffs: t.made_playoffs, champion: t.champion, runner_up: t.runner_up, last_place: t.last_place,
      pf: r2(t.points_for), pa: r2(t.points_against), pf_idx: t.pf_idx, pf_rank: t.pf_rank,
      pa_rank: peers.filter((x) => x.points_against > t.points_against).length + 1, avg_pf: r1(avgPf),
      allplay_w: t.allplay_w, allplay_l: t.allplay_l, allplay_pct: t.allplay_pct, xw: t.expected_wins, luck: t.luck,
      efficiency: t.efficiency, bench_lost: t.bench_lost_per_week, avg_rel: t.avg_rel_score,
      first_half_rel: t.first_half_rel, second_half_rel: t.second_half_rel,
      draft_sp_share: t.draft_sp_share, draft_vos: t.draft_vos,
      eff_rank: peers.filter((x) => x.efficiency > t.efficiency).length + 1,
      luck_rank: peers.filter((x) => x.luck > t.luck).length + 1,
    },
    sources: { draft: (t.sp_draft || 0) + (t.sp_keeper || 0), waiver: t.sp_waiver || 0, free_agent: t.sp_free_agent || 0, trade: t.sp_trade || 0, unknown: t.sp_unknown || 0 },
    pos: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => ({ pos: p, sp: r1(t['sp_' + p]), vs_avg: t[p + '_vs_avg_pw'], rank: t['rk_' + p] })),
    log, roster, grid,
    draft: (draftByTeam[key] || []).sort((a, b) => a.overall - b.overall).map((d) => ({ round: d.round, overall: d.overall, name: d.player_name,
      pos: d.pos, keeper: d.is_keeper, grade: d.grade || null, pos_rank: d.pos_rank, vos: r1(d.value_over_slot), sp: r1(d.sp_for_team) })),
    trades: trades.filter((x) => x.season === t.season && x.person === t.person),
  });
}

await write('site.json', {
  built_at: new Date().toISOString(), exported_at: exportedAt,
  seasons: seasonList, owners: ownerList,
  latest_season: Math.max(...seasons.map((s) => s.season)),
});
console.log(`Shaped ${seasons.length} seasons, ${careers.length} owners, ${games.length / 2} games → src/generated/`);
