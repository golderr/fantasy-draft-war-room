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

test("Late-Round is the default sort in both views", () => {
  assert.match(appScript, /sort: \{ live:\{key:'lr',dir:'asc'\}, rankings:\{key:'lr',dir:'asc'\} \}/);
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
});
