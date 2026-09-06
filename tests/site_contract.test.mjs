import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const wrapper = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const srcdocMatch = wrapper.match(/srcdoc="([\s\S]*)"><\/iframe>/);
assert.ok(srcdocMatch, "site wrapper should contain an iframe srcdoc");

const decode = (value) => value
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#x27;", "'")
  .replaceAll("&amp;", "&");

const app = decode(srcdocMatch[1]);
const scripts = [...app.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const appScript = scripts.find((script) => script.includes("const root = document.getElementById('draft-room-tool')"));
assert.ok(appScript, "draft tool script should be present");

test("embedded draft tool JavaScript parses", () => {
  assert.doesNotThrow(() => new Function(appScript));
});

test("tooltips use one app-owned trigger system", () => {
  assert.match(app, /data-dft-tooltip-layer/);
  assert.match(app, /data-dft-tip=/);
  assert.doesNotMatch(app, /data-tooltip=/);
  assert.match(appScript, /closest\('\[data-dft-tip\]'\)/);
});

test("table starts with star and round, then player, then Late-Round", () => {
  const liveHead = app.match(/<table aria-label="Available player board">[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/)?.[1] ?? "";
  const labels = [...liveHead.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((match) => match[1].replace(/<[^>]+>/g, "").trim());
  assert.equal(labels.length, 17);
  assert.match(labels[0], /★ R/);
  assert.match(labels[1], /Player/);
  assert.match(labels[2], /Late-Round/);
  assert.match(labels[13], /V median/);
  assert.match(labels[14], /V rank/);
});

test("Late-Round stays the default draft sort and 2025 results start by pace", () => {
  assert.match(appScript, /sort: \{ live:\{key:'lr',dir:'asc'\}, rankings:\{key:'lr',dir:'asc'\}, past:\{key:'paceRank',dir:'asc'\} \}/);
});

test("2025 half-PPR results cover the entire draft-tool player pool", () => {
  assert.match(app, /data-view-button="past"[^>]*>2025 results<\/button>/);
  assert.match(app, /<table aria-label="2025 half-PPR performance">/);
  const dataLiteral = appScript.match(/const history2025Rows = (\[[^\n]+\]);/)?.[1];
  assert.ok(dataLiteral, "2025 history data should be extractable");
  const rows = Function(`return ${dataLiteral}`)();
  assert.equal(rows.length, 270);
  assert.equal(rows.filter((row) => row[4] != null).length, 240);
  assert.equal(rows.filter((row) => row[10] === "rookie").length, 30);
  assert.equal(rows.filter((row) => row[4] != null && row[3] < 17).length, 141);
});

test("2025 scoring, pace, ADP, and missed-time evidence remain distinct", () => {
  const dataLiteral = appScript.match(/const history2025Rows = (\[[^\n]+\]);/)?.[1];
  const rows = Function(`return ${dataLiteral}`)();
  const byName = new Map(rows.map((row) => [row[0], row]));
  assert.deepEqual(byName.get("Christian McCaffrey").slice(1, 9), ["RB", "SF", 17, 365.6, 365.6, 365.6, 365.6, 8.6]);
  assert.deepEqual(byName.get("Josh Allen").slice(1, 9), ["QB", "BUF", 17, 364.6, 374.6, 364.6, 374.6, 22.7]);
  assert.deepEqual(byName.get("Ja'Marr Chase").slice(1, 11), ["WR", "CIN", 16, 251.1, 251.1, 266.8, 266.8, 1.4, "NFL suspension (Week 12)", "suspension"]);
  assert.equal(byName.get("MarShawn Lloyd")[6], null, "zero-game players should not receive a made-up pace");
  assert.match(appScript, /const hasAsterisk=row\.actual!=null&&row\.games<17/);
  assert.match(appScript, /data-dft-tip=/);
  assert.match(appScript, /Straight-line pace; not a durability forecast/);
  assert.match(appScript, /row\.yahooAdp-row\.paceRank/);
});

test("Late-Round board uses the September 4 page 294 release", () => {
  const dataLiteral = appScript.match(/const late = (\[[^\n]+\]);/)?.[1];
  assert.ok(dataLiteral, "Late-Round data should be extractable");
  const rows = Function(`return ${dataLiteral}`)();
  assert.equal(rows.length, 250);
  assert.deepEqual(rows.map((row) => row[0]), Array.from({ length: 250 }, (_, index) => index + 1));
  const byName = new Map(rows.map((row) => [row[1], row]));
  assert.deepEqual(byName.get("Alec Pierce"), [81, "Alec Pierce", "WR", 14]);
  assert.deepEqual(byName.get("Joe Burrow"), [76, "Joe Burrow", "QB", 13]);
  assert.deepEqual(byName.get("Isiah Pacheco"), [234, "Isiah Pacheco", "RB", 28]);
  assert.match(app, /page 294 of the September 4 guide/);
});

test("official room ranks cover the deep board without a false Late-Round fallback", () => {
  const dataLiteral = appScript.match(/const adp = (\[[^\n]+\]);/)?.[1];
  assert.ok(dataLiteral, "room-rank data should be extractable");
  const rows = Function(`return ${dataLiteral}`)();
  assert.equal(rows.length, 250);
  assert.equal(rows.filter((row) => Number.isFinite(row[4])).length, 249);
  assert.equal(rows.filter((row) => Number.isFinite(row[5])).length, 249);
  assert.equal(rows.filter((row) => Number.isFinite(row[7])).length, 183);
  const pick105 = rows.find((row) => row[0] === 105);
  assert.ok(Number.isFinite(pick105[4]));
  assert.ok(Number.isFinite(pick105[5]));
  assert.equal(pick105[4] - pick105[0], 42, "ESPN LR edge should use ESPN room rank");
  assert.equal(pick105[5] - pick105[0], -14, "Yahoo LR edge should use Yahoo room rank");
  assert.match(appScript, /const activeRank = p => Number\.isFinite\(p\[state\.platform\]\) \? p\[state\.platform\] : null/);
  assert.doesNotMatch(appScript, /p\[state\.platform\] == null \? p\.consensus/);
});

test("skill-player totals are half-PPR, not full-PPR", () => {
  const dataLiteral = appScript.match(/const espnProjectionData = (\[[^\n]+\]);/)?.[1];
  assert.ok(dataLiteral, "projection data should be extractable");
  const rows = Function(`return ${dataLiteral}`)();
  const skillRows = rows.filter((row) => ["RB", "WR", "TE"].includes(row[1]));
  assert.equal(skillRows.length, 209);
  for (const row of skillRows) {
    const [, , , espnPoints, , , , rushYards, rushTds, receptions, recYards, recTds] = row;
    const halfPpr = 0.1 * rushYards + 6 * rushTds + 0.5 * receptions + 0.1 * recYards + 6 * recTds;
    assert.ok(Math.abs(halfPpr - espnPoints) < 1, `${row[0]} should reproduce within source rounding`);
  }
});

test("Vegas rank uses qualified evidence and peer-median normalization", () => {
  assert.match(appScript, /values\.length>=5/);
  assert.match(appScript, /item\.points-baseline/);
  assert.match(appScript, /components\.length<2/);
  assert.match(appScript, /Vegas-relative/);
  assert.match(appScript, /roomEdge:roomRank==null\?null:roomRank-rank/);
  assert.match(appScript, /insight\.roomEdge>0\?'good':insight\.roomEdge<0\?'bad'/);
  assert.match(appScript, /cohortOrdinalMap\(qualifiedPlayers,activeRank\)/);
});
